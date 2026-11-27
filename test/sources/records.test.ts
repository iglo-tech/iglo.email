// B150d (15-external-sources sections 3, 4, 5 and 7, D173): source records into subscribers,
// consent and leaving, through the running stream against the real PocketBase 0.40.5 binary,
// observed through the subscribers, enrollments and send-log APIs, the SMTP sink and the stream's
// retry queue. The scheduler fixture's clock is the stream's: a test moves it only while the
// stream waits, or to run the scheduler.
//
// Four transport hooks: `failRecipients` answers the recipients view with a 503, a transient error
// the binary cannot produce on demand; `refuseHistory` answers an events-collection query naming one
// event with the 400 PocketBase gives a filter it refuses (a permanent `trigger.condition` failure
// for that name only); `hold` delays one recipients read (the binary's answer, unchanged) so a
// test can change SQLite between the handler's reads and its write transaction; and `malformed`
// answers one user's recipients read with the binary's row whose address is a number (a permanent
// read failure that is not an ID the source cannot have). B166 adds three: `refuseRecipients`
// answers the recipients view with PocketBase's `400`, `beforeQuery` runs a change on the binary (a
// password rotation, a field rename) just before one events query is forwarded, `holdQuery` holds
// one events query (the schema probe) until the test releases it, and `html` answers
// every request with a 200 HTML page (a proxy put in front of the source); round 4's `emptyProbe`
// answers the events schema probe with a 200 `{}` (a misconfigured proxy). B168's `goneProxy`
// answers every recipients read by ID with a 404 and the view's collection probe with a 200 `{}`.
// Every source request also records whether a SQLite
// transaction was open when it was sent: none may be (no network call inside a transaction).
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { writeTransaction } from "@/db/transaction";
import type { Guard } from "@/sources/connect";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import type { RecordOutcome } from "@/sources/records";
import { createSourceRecords } from "@/sources/records-stream";
import type { SourceRecords } from "@/sources/records-stream";
import type { GrantRule } from "@/sources/settings";
import { TOPIC_CHECK_MS } from "@/sources/stream";
import { adapter } from "@/test/conditions/source-fixture";
import type { JsonObject } from "@/test/json-object";
import { asBody, readJson } from "@/test/read-body";
import { day, minute, schedulerFixture } from "@/test/scheduler/fixture";
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
  /** An events query whose filter names this event is answered 400; null: none. */
  refuseHistory: { name: string | null };
  config: { current: PocketBaseConfig };
  rules: { current: Array<GrantRule> };
  /** Holds the next recipients-view read of `user` until `released` settles (once). */
  hold: { current: { user: string; reached: () => void; released: Promise<void> } | null };
  /** This user's recipients-view reads answer its row with a number for the address; null: none. */
  malformed: { user: string | null };
  /** While on, every recipients-view read is answered with PocketBase's `400`. */
  refuseRecipients: { on: boolean };
  /** Runs once before the first events query whose filter includes `includes` is forwarded. */
  beforeQuery: { current: { includes: string; run: () => Promise<void> } | null };
  /** Holds the first events query whose filter includes `includes` until `released` settles. */
  holdQuery: {
    current: { includes: string; reached: () => void; released: Promise<void> } | null;
  };
  /** While on, every source request is answered with a 200 HTML page (a proxy's or SSO page). */
  html: { on: boolean };
  /** While on, the events schema probe is answered with a 200 `{}` (a misconfigured proxy). */
  emptyProbe: { on: boolean };
  /**
   * While on, every recipients read by ID is answered with a 404 and the recipients collection
   * probe with a 200 `{}` (a misconfigured proxy).
   */
  goneProxy: { on: boolean };
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

/** PocketBase's answer to a filter or a read it refuses. */
const refusal = () =>
  Response.json(
    { status: 400, message: "Something went wrong while processing your request.", data: {} },
    { status: 400 },
  );

async function start(
  options: {
    config?: Partial<PocketBaseConfig>;
    rules?: Array<GrantRule>;
    emailAllowed?: (email: string) => boolean;
    guard?: Guard;
  } = {},
): Promise<Harness> {
  const f = await schedulerFixture({ source: () => adapter(pb) });
  const outcomes: Array<RecordOutcome> = [];
  const attention: Array<string> = [];
  const inTransaction: Array<string> = [];
  const failRecipients = { on: false };
  const refuseHistory: Harness["refuseHistory"] = { name: null };
  const config = { current: { ...sourceConfig(pb.url, pb.service), ...options.config } };
  const rules = { current: options.rules ?? [] };
  const hold: Harness["hold"] = { current: null };
  const malformed: Harness["malformed"] = { user: null };
  const refuseRecipients = { on: false };
  const beforeQuery: Harness["beforeQuery"] = { current: null };
  const holdQuery: Harness["holdQuery"] = { current: null };
  const html = { on: false };
  const emptyProbe = { on: false };
  const goneProxy = { on: false };
  const records = createSourceRecords({
    db: f.db,
    clock: f.clock,
    logger: {
      attention: (message) => attention.push(message),
      error: (error) => attention.push(`error: ${String(error)}`),
    },
    config: () => config.current,
    grantRules: () => rules.current,
    guard: options.guard ?? openGuard,
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
        if (html.on) {
          return Promise.resolve(
            new Response("<!doctype html><title>Sign in</title>", {
              headers: { "content-type": "text/html" },
            }),
          );
        }
        if (
          refuseRecipients.on &&
          input.pathname.startsWith("/api/collections/recipients/records/")
        ) {
          return Promise.resolve(refusal());
        }
        const before = beforeQuery.current;
        if (
          before &&
          input.pathname === "/api/collections/events/records" &&
          (input.searchParams.get("filter") ?? "").includes(before.includes)
        ) {
          beforeQuery.current = null;
          return before.run().then(() => fetch(input, init));
        }
        const heldQuery = holdQuery.current;
        if (
          heldQuery &&
          input.pathname === "/api/collections/events/records" &&
          (input.searchParams.get("filter") ?? "").includes(heldQuery.includes)
        ) {
          holdQuery.current = null;
          heldQuery.reached();
          return heldQuery.released.then(() => fetch(input, init));
        }
        if (goneProxy.on && input.pathname.startsWith("/api/collections/recipients/records/")) {
          return Promise.resolve(
            Response.json(
              { status: 404, message: "The requested resource wasn't found.", data: {} },
              { status: 404 },
            ),
          );
        }
        if (goneProxy.on && input.pathname === "/api/collections/recipients/records") {
          return Promise.resolve(Response.json({}));
        }
        if (
          emptyProbe.on &&
          input.pathname === "/api/collections/events/records" &&
          (input.searchParams.get("filter") ?? "").includes(PROBE)
        ) {
          return Promise.resolve(Response.json({}));
        }
        const refused = refuseHistory.name;
        if (
          refused !== null &&
          input.pathname === "/api/collections/events/records" &&
          (input.searchParams.get("filter") ?? "").includes(refused)
        ) {
          return Promise.resolve(
            Response.json(
              {
                status: 400,
                message: "Something went wrong while processing your request.",
                data: {},
              },
              { status: 400 },
            ),
          );
        }
        const held = hold.current;
        if (held && input.pathname === `/api/collections/recipients/records/${held.user}`) {
          hold.current = null;
          held.reached();
          return held.released.then(() => fetch(input, init));
        }
        if (
          malformed.user !== null &&
          input.pathname === `/api/collections/recipients/records/${malformed.user}`
        ) {
          return fetch(input, init).then(async (answer) =>
            Response.json({ ...(await readJson<JsonObject>(answer)), email: 42 }, answer),
          );
        }
        return fetch(input, init);
      },
    },
    subscribers: f.stores.subscribers,
    enrollments: f.stores.enrollments,
    emailAllowed: options.emailAllowed ?? (() => true),
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
    refuseHistory,
    config,
    rules,
    hold,
    malformed,
    refuseRecipients,
    beforeQuery,
    holdQuery,
    html,
    emptyProbe,
    goneProxy,
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
/** Waits until the record is handled or queued; fails with the queued row when it was queued. */
async function settled(h: Harness, record: { id: string }) {
  const queued = () =>
    (h.records.stream()?.retries() ?? []).find((row) => row.record_id === record.id);
  await until(
    h,
    () => h.outcomes.some((o) => o.record === record.id) || queued() !== undefined,
    `record ${record.id} handled or queued`,
  );
  expect({ queued: queued() ?? null, attention: h.attention }).toMatchObject({ queued: null });
}
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

test("B163: a changed address onto a gone holder's address in a blocklisted domain is refused with nothing written; the re-point still takes it", async () => {
  const domain = `blocked-${crypto.randomUUID().slice(0, 8)}.example.com`;
  const h = await start({ emailAllowed: (email) => !email.endsWith(`@${domain}`) });
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news] }];
  await resubscribed(h);
  // The user already has a subscriber: its address changes onto a gone holder's (a user the view
  // never had), in the blocklisted domain. That is a new address: terminal, nothing written.
  const address = `mover-${crypto.randomUUID().slice(0, 8)}@${domain}`;
  const mover = await pb.user({ email: address });
  const oldAddress = `old-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const own = await createSubscriber(h, { email: oldAddress, external_id: mover.id });
  const holder = await createSubscriber(h, { email: address, external_id: "ghostuser000002" });
  const signup = await record(h, mover, "signup");
  const queued = () =>
    (h.records.stream()?.retries() ?? []).find((entry) => entry.record_id === signup.id);
  await until(
    h,
    () => queued() !== undefined || h.outcomes.some((o) => o.record === signup.id),
    "the record handled or queued",
  );
  expect(h.outcomes.some((o) => o.record === signup.id)).toBe(false);
  expect(Boolean(queued()?.terminal)).toBe(true);
  expect(h.attention.join("\n")).toContain(`${mover.id}'s address is in a blocklisted domain`);
  expect(await byId(h, own)).toMatchObject({ email: oldAddress, external_id: mover.id });
  expect(await byId(h, holder)).toMatchObject({ email: address, external_id: "ghostuser000002" });

  // A user with no subscriber yet: the gone holder already holds the address and is re-pointed.
  const repointed = `repoint-${crypto.randomUUID().slice(0, 8)}@${domain}`;
  const incoming = await pb.user({ email: repointed });
  const imported = await createSubscriber(h, { email: repointed });
  const second = await record(h, incoming, "signup");
  await settled(h, second);
  expect(await byId(h, imported)).toMatchObject({ email: repointed, external_id: incoming.id });
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

test("leaving with an address-only suppression also suppresses the user ID: a user returning under a new address is refused the grant and sent nothing", async () => {
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
  const user = await pb.user();
  // Subscribed with no user ID, then the public "all lists" option: an address-only suppression
  // (D125, D128) and an unsubscribed list. The user ID is linked afterwards.
  const id = await createSubscriber(h, {
    email: emailOf(user),
    lists: [news],
    preconfirm_subscriptions: true,
  });
  writeTransaction(h.f.db, () => h.f.stores.subscribers.unsubscribeAll(BigInt(id)));
  const linkId = await h.f.json(`/api/subscribers/${id}`, "PATCH", { external_id: user.id });
  expect(linkId.status).toBe(200);
  expect(statusOn(await linked(h, user), news)).toBe("unsubscribed");

  await pb.update("users", user.id, { deletedAt: new Date().toISOString() });
  await until(
    h,
    () => h.outcomes.some((o) => o.record === user.id && o.kind === "left"),
    "leaving",
  );
  expect(await linked(h, user)).toBeNull();
  // Back under a new address with the same user ID.
  const fresh = `back-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await pb.update("users", user.id, { deletedAt: "", email: fresh });
  const order = await record(h, user, "order_paid");
  await handled(h, order);
  expect(outcome(h, order)).toMatchObject({
    grants: [{ list_id: news, result: "suppressed" }],
    started: 0,
  });
  const back = await linked(h, user);
  expect(back?.email).toBe(fresh);
  expect(statusOn(back, news)).toBeNull();

  await h.f.pass(0);
  expect(await h.f.sendLog()).toEqual([]);
});

test("B168: a gone holder re-pointed to a user who withdrew and left takes the withdrawal: its marketing ends and nothing is sent", async () => {
  const h = await start();
  const news = await h.f.list("News");
  const template = await h.f.template();
  await h.f.sequence({
    source: "external",
    list_id: news,
    trigger: { event: h.ev("order_paid") },
    steps: [{ wait: "PT0S", kind: "marketing", template_id: template }],
  });
  await resubscribed(h);
  const user = await pb.user();
  // The user's subscriber, withdrawn from all lists (a suppression of its address and user ID).
  const own = await createSubscriber(h, {
    email: emailOf(user),
    external_id: user.id,
    lists: [news],
    preconfirm_subscriptions: true,
  });
  writeTransaction(h.f.db, () => h.f.stores.subscribers.unsubscribeAll(BigInt(own)));
  await pb.update("users", user.id, { deletedAt: new Date().toISOString() });
  await until(
    h,
    () => h.outcomes.some((o) => o.record === user.id && o.kind === "left"),
    "leaving",
  );
  // An unlinked holder (an import) of the address the user comes back under, confirmed on News.
  const fresh = `back-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const holder = await createSubscriber(h, {
    email: fresh,
    lists: [news],
    preconfirm_subscriptions: true,
  });
  await pb.update("users", user.id, { deletedAt: "", email: fresh });
  const order = await record(h, user, "order_paid");
  await handled(h, order);

  const row = await byId(h, holder);
  expect(row).toMatchObject({ email: fresh, external_id: user.id, status: "enabled" });
  expect(statusOn(row, news)).toBe("unsubscribed");
  expect(outcome(h, order).started).toBe(0);
  await h.f.pass(0);
  expect(await h.f.sendLog()).toEqual([]);
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

test("a holder blocklisted while its read is out stays blocklisted when re-pointed: the grant is refused and nothing is sent", async () => {
  const h = await start();
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news] }];
  const template = await h.f.template();
  await h.f.sequence({
    source: "external",
    list_id: news,
    trigger: { event: h.ev("signup") },
    steps: [{ wait: "PT0S", kind: "marketing", template_id: template }],
  });
  await resubscribed(h);
  const incoming = await pb.user();
  const address = emailOf(incoming);
  // The holder names a user the view does not have: its read decides "gone", a re-point.
  const ghost = "ghostuser000003";
  const holder = await createSubscriber(h, { email: address, external_id: ghost });
  const atHold = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  h.hold.current = { user: ghost, reached: atHold.resolve, released: released.promise };
  const signup = await record(h, incoming, "signup");
  await atHold.promise;
  expect((await h.f.json("/api/subscribers/blocklist", "PUT", { ids: [holder] })).status).toBe(200);
  released.resolve();
  await handled(h, signup);

  expect(await byId(h, holder)).toMatchObject({
    email: address,
    external_id: incoming.id,
    status: "blocklisted",
  });
  expect(outcome(h, signup).grants).toEqual([{ list_id: news, result: "blocklisted" }]);
  expect(statusOn(await byId(h, holder), news)).toBeNull();
  expect(await enrollmentsOf(h, holder)).toEqual([]);
  await h.f.pass(0);
  expect(await h.f.sendLog()).toEqual([]);
});

test("a moving holder blocklisted while its read is out keeps its blocklist at its new address", async () => {
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
  const atHold = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  h.hold.current = { user: holderUser.id, reached: atHold.resolve, released: released.promise };
  const signup = await record(h, incoming, "signup");
  await atHold.promise;
  expect((await h.f.json("/api/subscribers/blocklist", "PUT", { ids: [holder] })).status).toBe(200);
  released.resolve();
  await handled(h, signup);

  expect(await byId(h, holder)).toMatchObject({
    email: moved,
    external_id: holderUser.id,
    status: "blocklisted",
  });
  expect((await linked(h, incoming))?.id).not.toBe(holder);
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

// ---------------------------------------------------------------------------------------------
// B155d (D179).

test("a record older than 7 days exits and grants but starts nothing; one inside the window starts", async () => {
  const h = await start();
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("order_paid"), where: {}, lists: [news] }];
  const template = await h.f.template();
  const starting = await h.f.sequence({
    source: "external",
    trigger: { event: h.ev("order_paid") },
    steps: [tx(template)],
  });
  const exiting = await h.f.sequence({
    source: "external",
    trigger: { event: h.ev("visit") },
    exit_on: [h.ev("order_paid")],
    steps: [tx(template)],
  });
  await resubscribed(h);
  const ana = await pb.user();
  const visit = await record(h, ana, "visit");
  await handled(h, visit);
  const at = (ms: number) => ({
    occurredAt: new Date(h.f.clock.now().getTime() - ms).toISOString(),
  });
  const old = await pb.event(ana.id, h.ev("order_paid"), {}, at(8 * day));
  await settled(h, old);
  expect(outcome(h, old)).toMatchObject({
    kind: "written",
    grants: [{ list_id: news, result: "added" }],
    started: 0,
    ended: 1,
  });
  const subscriber = (await linked(h, ana))?.id ?? 0;
  expect(
    (await enrollmentsOf(h, subscriber)).map((e) => [
      asBody<number>(e.sequence_id),
      asBody<string>(e.status),
    ]),
  ).toEqual([[exiting.id, "exited"]]);
  const recent = await pb.event(ana.id, h.ev("order_paid"), {}, at(6 * day));
  await settled(h, recent);
  expect(outcome(h, recent)).toMatchObject({ kind: "written", started: 1 });
  expect(
    (await enrollmentsOf(h, subscriber)).find((e) => e.sequence_id === starting.id),
  ).toMatchObject({ status: "active", trigger_external_id: recent.id });
});

test("a trigger.condition the source refuses skips only that sequence with one attention line; the grants and other sequences apply", async () => {
  const h = await start();
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("order_paid"), where: {}, lists: [news] }];
  const template = await h.f.template();
  const refused = await h.f.sequence({
    source: "external",
    trigger: {
      event: h.ev("order_paid"),
      condition: { event: h.ev("history"), count: { gte: 1 } },
    },
    steps: [tx(template)],
  });
  const plain = await h.f.sequence({
    source: "external",
    trigger: { event: h.ev("order_paid") },
    steps: [tx(template)],
  });
  await resubscribed(h);
  h.refuseHistory.name = h.ev("history");
  const users = [await pb.user(), await pb.user()];
  for (const user of users) {
    const paid = await record(h, user, "order_paid");
    await settled(h, paid);
    expect(outcome(h, paid)).toMatchObject({
      kind: "written",
      grants: [{ list_id: news, result: "added" }],
      started: 1,
    });
    const subscriber = (await linked(h, user))?.id ?? 0;
    expect((await enrollmentsOf(h, subscriber)).map((e) => asBody<number>(e.sequence_id))).toEqual([
      plain.id,
    ]);
  }
  const lines = h.attention.filter((line) => line.includes("Sequence trigger condition failed"));
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain(`sequence ${refused.id}`);
  expect(h.records.stream()?.retries()).toEqual([]);
});

test("address conflict: a holder whose external_id the source cannot have (set by pushed events) is gone: re-pointed, keeping its unsubscribes", async () => {
  const h = await start();
  const news = await h.f.list("News");
  const other = await h.f.list("Other");
  h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news, other] }];
  await resubscribed(h);
  const incoming = await pb.user();
  const address = emailOf(incoming);
  const legacy = `crm:${crypto.randomUUID().slice(0, 8)}`;
  const holder = await createSubscriber(h, {
    email: address,
    external_id: legacy,
    lists: [news],
    preconfirm_subscriptions: true,
  });
  await unsubscribe(h, holder, news);
  const signup = await record(h, incoming, "signup");
  await settled(h, signup);

  const row = await byId(h, holder);
  expect(row).toMatchObject({ email: address, external_id: incoming.id, status: "enabled" });
  expect(statusOn(row, news)).toBe("unsubscribed");
  expect(statusOn(row, other)).toBe("confirmed");
  expect(outcome(h, signup).grants).toEqual([
    { list_id: news, result: "unsubscribed" },
    { list_id: other, result: "added" },
  ]);
});

test("address conflict: a holder whose read fails permanently for another reason (a malformed address field) is a terminal conflict: the holder is neither re-pointed nor deleted", async () => {
  // B159a (D182): only an ID the source cannot have (`NotSourceId`) makes a holder gone; any other
  // permanent failure of its read leaves the holder as it is.
  const h = await start();
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news] }];
  await resubscribed(h);
  const incoming = await pb.user();
  const address = emailOf(incoming);
  const holderUser = await pb.user();
  const holder = await createSubscriber(h, {
    email: address,
    external_id: holderUser.id,
    lists: [news],
    preconfirm_subscriptions: true,
  });
  h.malformed.user = holderUser.id;
  const signup = await record(h, incoming, "signup");
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
  expect(h.attention.join("\n")).toContain("field is not text");
  expect(await linked(h, incoming)).toBeNull();
  const kept = await byId(h, holder);
  expect(kept).toMatchObject({ email: address, external_id: holderUser.id, status: "enabled" });
  expect(statusOn(kept, news)).toBe("confirmed");
});

test("address conflict: two users who swap addresses are swapped in one transaction, each row keeping its consent; a third holder stays a terminal conflict", async () => {
  const h = await start();
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news] }];
  await resubscribed(h);
  const a = await pb.user();
  const b = await pb.user();
  const x = emailOf(a);
  const y = emailOf(b);
  const rowA = await createSubscriber(h, {
    email: x,
    external_id: a.id,
    lists: [news],
    preconfirm_subscriptions: true,
  });
  await unsubscribe(h, rowA, news);
  const rowB = await createSubscriber(h, { email: y, external_id: b.id });
  // PocketBase keeps auth addresses unique, so the swap goes through a temporary one there too.
  await pb.update("users", a.id, { email: `tmp-${crypto.randomUUID().slice(0, 8)}@example.com` });
  await pb.update("users", b.id, { email: x });
  await pb.update("users", a.id, { email: y });
  const signup = await record(h, b, "signup");
  await settled(h, signup);

  const afterA = await byId(h, rowA);
  const afterB = await byId(h, rowB);
  expect(afterA).toMatchObject({ email: y, external_id: a.id });
  expect(statusOn(afterA, news)).toBe("unsubscribed");
  expect(afterB).toMatchObject({ email: x, external_id: b.id });
  expect(outcome(h, signup).grants).toEqual([{ list_id: news, result: "added" }]);
  // A's own record finds both rows in step with the view.
  const again = await record(h, a, "signup");
  await settled(h, again);
  expect(outcome(h, again).grants).toEqual([{ list_id: news, result: "unsubscribed" }]);
  expect((await byId(h, rowA))?.email).toBe(y);

  // A rotation through three users is not a swap: the bound stays a terminal conflict.
  const c = await pb.user();
  const d = await pb.user();
  const e = await pb.user();
  const [cx, dx, ex] = [emailOf(c), emailOf(d), emailOf(e)];
  await createSubscriber(h, { email: cx, external_id: c.id });
  await createSubscriber(h, { email: dx, external_id: d.id });
  await createSubscriber(h, { email: ex, external_id: e.id });
  // c takes d's address, d takes e's, e takes c's.
  await pb.update("users", c.id, { email: `tmp-${crypto.randomUUID().slice(0, 8)}@example.com` });
  await pb.update("users", e.id, { email: cx });
  await pb.update("users", d.id, { email: ex });
  await pb.update("users", c.id, { email: dx });
  const rotated = await record(h, c, "signup");
  await until(
    h,
    () => (h.records.stream()?.retries() ?? []).some((row) => row.record_id === rotated.id),
    "the terminal row",
  );
  expect(h.attention.join("\n")).toContain("moved to an address subscriber");
});

test("a suppression left on leaving is lifted by an operator's DELETE or the person's double opt-in confirmation; the returning user is then granted again", async () => {
  const h = await start();
  const news = await h.f.list("News");
  const double = await h.f.list("Double", "double");
  h.rules.current = [{ event: h.ev("order_paid"), where: {}, lists: [news] }];
  const template = await h.f.template();
  await h.f.sequence({
    source: "external",
    list_id: news,
    trigger: { event: h.ev("order_paid") },
    steps: [{ wait: "P1D", kind: "marketing", template_id: template }],
  });
  await resubscribed(h);
  const viaDelete = await pb.user();
  const viaOptin = await pb.user();
  const moved = await pb.user();
  const users = [viaDelete, viaOptin, moved];
  for (const user of users) {
    const id = await createSubscriber(h, {
      email: emailOf(user),
      external_id: user.id,
      lists: [news],
      preconfirm_subscriptions: true,
    });
    await unsubscribe(h, id, news);
    await pb.update("users", user.id, { deletedAt: new Date().toISOString() });
    await until(
      h,
      () => h.outcomes.some((o) => o.record === user.id && o.kind === "left"),
      "leaving",
    );
  }
  // Each comes back, `moved` under a new address: refused while the suppression stands.
  const newAddress = `back-${crypto.randomUUID().slice(0, 8)}@example.com`;
  for (const user of users) {
    await pb.update(
      "users",
      user.id,
      user === moved ? { deletedAt: "", email: newAddress } : { deletedAt: "" },
    );
    const order = await record(h, user, "order_paid");
    await settled(h, order);
    expect(outcome(h, order)).toMatchObject({
      grants: [{ list_id: news, result: "suppressed" }],
      started: 0,
    });
  }

  const lift = async (email: string) => {
    const r = await h.f.json("/api/suppressions", "DELETE", { email });
    expect(r.status).toBe(200);
    return asBody<number>(r.body.data.removed);
  };
  expect(await lift(emailOf(viaDelete))).toBe(1);
  // The suppression names the old address and the user ID: the new address alone lifts nothing.
  expect(await lift(newAddress)).toBe(0);
  expect(await lift(emailOf(moved))).toBe(1);
  // The person confirms a double opt-in list (the public confirmation page's store call).
  const optinRow = (await linked(h, viaOptin))?.id ?? 0;
  const added = await h.f.json("/api/subscribers/lists", "PUT", {
    ids: [optinRow],
    action: "add",
    target_list_ids: [double],
    status: "unconfirmed",
  });
  expect(added.status).toBe(200);
  writeTransaction(h.f.db, () =>
    h.f.stores.subscribers.confirmOptin(BigInt(optinRow), [BigInt(double)], {}),
  );

  for (const user of users) {
    const order = await record(h, user, "order_paid");
    await settled(h, order);
    expect(outcome(h, order)).toMatchObject({
      grants: [{ list_id: news, result: "added" }],
      started: 1,
    });
    expect(statusOn(await linked(h, user), news)).toBe("confirmed");
  }
});

// ---------------------------------------------------------------------------------------------
// B166 (D194).

for (const how of ["left", "wiped"] as const) {
  test(`B166: a subscriber moving onto the address of a person who ${how === "left" ? "unsubscribed and left" : "wiped their data"} takes the withdrawal: every list unsubscribed, its marketing enrollment ended, nothing sent`, async () => {
    const h = await start();
    const news = await h.f.list("News");
    const other = await h.f.list("Other");
    h.rules.current = [{ event: h.ev("visit"), where: {}, lists: [news] }];
    const template = await h.f.template();
    await h.f.sequence({
      source: "external",
      list_id: news,
      trigger: { event: h.ev("order_paid") },
      steps: [{ wait: "P1D", kind: "marketing", template_id: template }],
    });
    await resubscribed(h);

    let address: string;
    if (how === "left") {
      const gone = await pb.user();
      address = emailOf(gone);
      const id = await createSubscriber(h, {
        email: address,
        external_id: gone.id,
        lists: [news, other],
        preconfirm_subscriptions: true,
      });
      await unsubscribe(h, id, news);
      await pb.update("users", gone.id, { deletedAt: new Date().toISOString() });
      await until(
        h,
        () => h.outcomes.some((o) => o.record === gone.id && o.kind === "left"),
        "leaving",
      );
      // The account is gone from the view; its address is free in the source.
      await pb.update("users", gone.id, {
        email: `freed-${crypto.randomUUID().slice(0, 8)}@x.test`,
      });
    } else {
      address = `wiped-${crypto.randomUUID().slice(0, 8)}@example.com`;
      const id = await createSubscriber(h, {
        email: address,
        lists: [news, other],
        preconfirm_subscriptions: true,
      });
      writeTransaction(h.f.db, () => h.f.stores.subscribers.remove([BigInt(id)], { wipe: true }));
    }

    // Another user's subscriber: confirmed on both lists, in the marketing sequence.
    const mover = await pb.user();
    const moverId = await createSubscriber(h, {
      email: emailOf(mover),
      external_id: mover.id,
      lists: [news, other],
      preconfirm_subscriptions: true,
    });
    const order = await record(h, mover, "order_paid");
    await settled(h, order);
    expect(outcome(h, order)).toMatchObject({ started: 1 });

    // The user takes the address in the source; the next record writes it.
    await pb.update("users", mover.id, { email: address });
    const visit = await record(h, mover, "visit");
    await settled(h, visit);
    expect(outcome(h, visit)).toMatchObject({
      subscriberId: BigInt(moverId),
      grants: [{ list_id: news, result: "suppressed" }],
    });
    const moved = await linked(h, mover);
    expect(moved).toMatchObject({ id: moverId, email: address, status: "enabled" });
    expect(statusOn(moved, news)).toBe("unsubscribed");
    expect(statusOn(moved, other)).toBe("unsubscribed");
    const [enrollment] = await enrollmentsOf(h, moverId);
    expect(enrollment).toMatchObject({ status: "exited", exit_reason: "unsubscribed" });

    await h.f.pass(day);
    await h.f.pass(day);
    expect(await h.f.sendLog()).toEqual([]);
  });
}

test("B166: a source host the private-address block refuses while a record is handled refuses the stream: nothing terminal; listed again, the record is delivered", async () => {
  const hosts = { current: ["localhost"] };
  const h = await start({
    config: { url: `http://localhost:${pb.port}` },
    guard: { blockPrivate: () => true, privateHosts: () => hosts.current },
  });
  const template = await h.f.template();
  await h.f.sequence({
    source: "external",
    trigger: { event: h.ev("order_paid") },
    steps: [tx(template)],
  });
  await resubscribed(h);
  // The connection is open; an instance admin then removes the host from the list. The record
  // arrives on the open connection, and the handler's recipients read is refused.
  hosts.current = [];
  const ana = await pb.user();
  const paid = await record(h, ana, "order_paid");
  await until(
    h,
    () => h.attention.some((line) => line.includes("block_private_addresses")),
    "the refusal",
  );
  expect(h.records.stream()?.retries()).toEqual([]);
  expect(h.outcomes.some((o) => o.record === paid.id)).toBe(false);
  expect(await linked(h, ana)).toBeNull();

  hosts.current = ["localhost"];
  await live(h);
  await handled(h, paid);
  expect((await linked(h, ana))?.email).toBe(emailOf(ana));
  expect(h.records.stream()?.retries()).toEqual([]);
});

test("B166: a source host the private-address block refuses while a trigger.condition is read refuses the stream: nothing committed; listed again, the record starts its sequence once", async () => {
  const hosts = { current: ["localhost"] };
  const h = await start({
    config: { url: `http://localhost:${pb.port}` },
    guard: { blockPrivate: () => true, privateHosts: () => hosts.current },
  });
  const template = await h.f.template();
  // The condition counts the trigger record itself, so it holds once it can be read. No grant
  // rules: the condition's read is the record's first source read.
  const seq = await h.f.sequence({
    source: "external",
    trigger: {
      event: h.ev("order_paid"),
      condition: { event: h.ev("order_paid"), count: { gte: 1 } },
    },
    steps: [tx(template)],
  });
  await resubscribed(h);
  hosts.current = [];
  const ana = await pb.user();
  const paid = await record(h, ana, "order_paid");
  await until(
    h,
    () => h.attention.some((line) => line.includes("block_private_addresses")),
    "the refusal",
  );
  expect(h.records.stream()?.retries()).toEqual([]);
  expect(h.outcomes.some((o) => o.record === paid.id)).toBe(false);
  expect(h.attention.some((line) => line.includes("Sequence trigger condition failed"))).toBe(
    false,
  );
  expect(await linked(h, ana)).toBeNull();

  hosts.current = ["localhost"];
  await live(h);
  await handled(h, paid);
  expect(outcome(h, paid)).toMatchObject({ kind: "written", started: 1 });
  const subscriber = (await linked(h, ana))?.id ?? 0;
  expect((await enrollmentsOf(h, subscriber)).map((e) => asBody<number>(e.sequence_id))).toEqual([
    seq.id,
  ]);
  expect(h.outcomes.filter((o) => o.record === paid.id)).toHaveLength(1);
  expect(h.records.stream()?.retries()).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// B166 round 2 (D194): the stream never waits for good on what no settings change can fix, and
// never drops a record for good over what one can.

/** A record for an external sequence whose condition counts the trigger record itself. */
async function conditioned(h: Harness, condition?: JsonObject) {
  const template = await h.f.template();
  const seq = await h.f.sequence({
    source: "external",
    trigger: {
      event: h.ev("order_paid"),
      condition: condition ?? { event: h.ev("order_paid"), count: { gte: 1 } },
    },
    steps: [tx(template)],
  });
  await resubscribed(h);
  return seq;
}

/**
 * The record waits on a settings refusal (`refusal` names the attention line): nothing committed,
 * no condition failure, nothing queued. After `fix`, it starts the sequence exactly once.
 */
async function waitsThenStartsOnce(
  h: Harness,
  seq: { id: number },
  user: PocketBaseRecord,
  paid: { id: string },
  refusal: string,
  fix: () => Promise<void> | void,
) {
  await until(h, () => h.attention.some((line) => line.includes(refusal)), "the refusal");
  expect(h.records.stream()?.retries()).toEqual([]);
  expect(h.outcomes.some((o) => o.record === paid.id)).toBe(false);
  expect(h.attention.some((line) => line.includes("Sequence trigger condition failed"))).toBe(
    false,
  );
  expect(await linked(h, user)).toBeNull();
  await fix();
  await live(h);
  await handled(h, paid);
  expect(outcome(h, paid)).toMatchObject({ kind: "written", started: 1 });
  const subscriber = (await linked(h, user))?.id ?? 0;
  expect((await enrollmentsOf(h, subscriber)).map((e) => asBody<number>(e.sequence_id))).toEqual([
    seq.id,
  ]);
  expect(h.outcomes.filter((o) => o.record === paid.id)).toHaveLength(1);
  expect(h.attention.some((line) => line.includes("Sequence trigger condition failed"))).toBe(
    false,
  );
  expect(h.records.stream()?.retries()).toEqual([]);
}

test("B166: a service-account password rotated while a trigger.condition is read refuses the stream (the sign-in's 400 is the settings'): nothing committed; with the password back, the sequence starts once", async () => {
  const h = await start();
  const seq = await conditioned(h);
  const ana = await pb.user();
  const [account] = (await pb.api("GET", "/api/collections/services/records")).items;
  const rotate = (password: string) =>
    pb.update("services", account.id, { password, passwordConfirm: password });
  h.beforeQuery.current = { includes: ana.id, run: () => rotate("rotated-password-7").then() };
  try {
    const paid = await record(h, ana, "order_paid");
    await waitsThenStartsOnce(h, seq, ana, paid, "Failed to authenticate", () =>
      rotate(pb.service.password).then(),
    );
  } finally {
    await rotate(pb.service.password);
  }
});

test("B166: a mapped events field renamed while a trigger.condition is read refuses the stream (the probe fails too): nothing committed; renamed back, the sequence starts once", async () => {
  const h = await start();
  const seq = await conditioned(h);
  const ana = await pb.user();
  let renamed = false;
  h.beforeQuery.current = {
    includes: ana.id,
    run: async () => {
      await pb.renameField("events", "name", "eventName");
      renamed = true;
    },
  };
  try {
    const paid = await record(h, ana, "order_paid");
    await waitsThenStartsOnce(h, seq, ana, paid, CONDITION_REFUSED, async () => {
      await pb.renameField("events", "eventName", "name");
      renamed = false;
    });
  } finally {
    if (renamed) {
      await pb.renameField("events", "eventName", "name");
    }
  }
});

const CONDITION_REFUSED = "The source refused a trigger condition's read";
/** The events schema probe's filter names every mapped field as `f = f`. */
const PROBE = "name = name";

test("B166 round 3: a mapped events field renamed when the user's only older event is nested 70 levels deep refuses the stream (the probe reads no record): nothing committed; renamed back, the sequence starts once", async () => {
  const h = await start();
  const seq = await conditioned(h);
  const ana = await pb.user();
  await pb.event(
    ana.id,
    h.ev("history"),
    { deep: nested(70) },
    { occurredAt: new Date(h.f.clock.now().getTime() - minute).toISOString() },
  );
  let renamed = false;
  h.beforeQuery.current = {
    includes: ana.id,
    run: async () => {
      await pb.renameField("events", "name", "eventName");
      renamed = true;
    },
  };
  try {
    const paid = await record(h, ana, "order_paid");
    await waitsThenStartsOnce(h, seq, ana, paid, CONDITION_REFUSED, async () => {
      await pb.renameField("events", "eventName", "name");
      renamed = false;
    });
  } finally {
    if (renamed) {
      await pb.renameField("events", "eventName", "name");
    }
  }
});

test("B166 round 3: a mapped events field renamed when the user has no event left at probe time refuses the stream: nothing committed and no condition failure", async () => {
  const h = await start();
  await conditioned(h);
  const ana = await pb.user();
  let renamed = false;
  let paid: { id: string } | undefined;
  h.beforeQuery.current = {
    includes: ana.id,
    run: async () => {
      await pb.renameField("events", "name", "eventName");
      renamed = true;
      if (paid) {
        await pb.remove("events", paid.id);
      }
    },
  };
  try {
    paid = await record(h, ana, "order_paid");
    await until(
      h,
      () => h.attention.some((line) => line.includes(CONDITION_REFUSED)),
      "the refusal",
    );
    expect(h.records.stream()?.retries()).toEqual([]);
    expect(h.outcomes.some((o) => o.record === paid?.id)).toBe(false);
    expect(h.attention.some((line) => line.includes("Sequence trigger condition failed"))).toBe(
      false,
    );
    expect(await linked(h, ana)).toBeNull();
  } finally {
    if (renamed) {
      await pb.renameField("events", "eventName", "name");
    }
  }
});

test("B166 round 3: the stream switching settings while the schema probe after a renamed field's 400 is in flight commits nothing; with the field back, the new stream starts the sequence once", async () => {
  const h = await start();
  const seq = await conditioned(h);
  const ana = await pb.user();
  let renamed = false;
  const { promise: probing, resolve: reached } = Promise.withResolvers<void>();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  h.beforeQuery.current = {
    includes: ana.id,
    run: async () => {
      await pb.renameField("events", "name", "eventName");
      renamed = true;
    },
  };
  h.holdQuery.current = { includes: PROBE, reached, released };
  try {
    const paid = await record(h, ana, "order_paid");
    await probing;
    await pb.renameField("events", "eventName", "name");
    renamed = false;
    // A settings switch that keeps the events markers: the running stream is stopped mid-probe.
    const first = h.records.stream();
    h.config.current = { ...h.config.current, users: { collection: "", leavingFilter: "" } };
    await h.records.refresh();
    expect(first?.state().state).toBe("stopped");
    release();
    await live(h);
    await handled(h, paid);
    expect(outcome(h, paid)).toMatchObject({ kind: "written", started: 1 });
    const subscriber = (await linked(h, ana))?.id ?? 0;
    expect((await enrollmentsOf(h, subscriber)).map((e) => asBody<number>(e.sequence_id))).toEqual([
      seq.id,
    ]);
    expect(h.outcomes.filter((o) => o.record === paid.id)).toHaveLength(1);
    expect(h.attention.some((line) => line.includes("Sequence trigger condition failed"))).toBe(
      false,
    );
  } finally {
    release();
    if (renamed) {
      await pb.renameField("events", "eventName", "name");
    }
  }
});

test("B166 round 4: a condition's 400 whose schema probe gets a 200 that is no PocketBase list (a proxy's {}) refuses the stream: nothing committed and no condition failure; with the probe answered, the 400 is the condition's own", async () => {
  const h = await start();
  const seq = await conditioned(h, { event: h.ev("history"), count: { gte: 1 } });
  const ana = await pb.user();
  h.refuseHistory.name = h.ev("history");
  h.emptyProbe.on = true;
  const paid = await record(h, ana, "order_paid");
  await until(h, () => h.attention.some((line) => line.includes(CONDITION_REFUSED)), "the refusal");
  expect(h.records.stream()?.retries()).toEqual([]);
  expect(h.outcomes.some((o) => o.record === paid.id)).toBe(false);
  expect(h.attention.some((line) => line.includes("Sequence trigger condition failed"))).toBe(
    false,
  );
  expect(await linked(h, ana)).toBeNull();
  // The probe answered by the source: the 400 is the condition's, and only its sequence is skipped.
  h.emptyProbe.on = false;
  await live(h);
  await handled(h, paid);
  expect(outcome(h, paid)).toMatchObject({ started: 0 });
  const lines = h.attention.filter((line) => line.includes("Sequence trigger condition failed"));
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain(`sequence ${seq.id}`);
});

test("B166: a recipients view answering 400 to a recipient condition refuses the stream: nothing committed and no condition failure; answering again, the sequence starts once", async () => {
  const h = await start();
  const seq = await conditioned(h, { recipient: "email", op: "ne", value: "nobody@example.com" });
  const ana = await pb.user();
  h.refuseRecipients.on = true;
  const paid = await record(h, ana, "order_paid");
  await waitsThenStartsOnce(
    h,
    seq,
    ana,
    paid,
    "The source refused a trigger condition's read",
    () => {
      h.refuseRecipients.on = false;
    },
  );
});

test("B168: a recipients read answered 404 whose collection probe gets a 200 that is no PocketBase list (a proxy's {}) refuses the stream: the live subscriber is kept; answered by the source, the record is handled once", async () => {
  const h = await start();
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news] }];
  await resubscribed(h);
  const ana = await pb.user();
  const signup = await record(h, ana, "signup");
  await handled(h, signup);
  const before = await linked(h, ana);
  expect(statusOn(before, news)).toBe("confirmed");

  h.goneProxy.on = true;
  const again = await record(h, ana, "signup");
  await until(
    h,
    () => h.attention.some((line) => line.includes("The recipients view refused a read")),
    "the refusal",
  );
  expect(h.outcomes.some((o) => o.record === again.id)).toBe(false);
  expect(h.records.stream()?.retries()).toEqual([]);
  const kept = await linked(h, ana);
  expect(kept?.id).toBe(before?.id ?? -1);
  expect(statusOn(kept, news)).toBe("confirmed");

  h.goneProxy.on = false;
  await live(h);
  await handled(h, again);
  expect(h.outcomes.filter((o) => o.record === again.id)).toHaveLength(1);
  expect((await linked(h, ana))?.id).toBe(before?.id ?? -1);
});

test("B168: many users failing for good for one cause (a blocklisted domain) write one attention line", async () => {
  const domain = `blocked-${crypto.randomUUID().slice(0, 8)}.test`;
  const h = await start({ emailAllowed: (email) => !email.endsWith(`@${domain}`) });
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news] }];
  await resubscribed(h);
  const ids: Array<string> = [];
  for (let i = 0; i < 6; i++) {
    const user = await pb.user({ email: `u${i}-${crypto.randomUUID().slice(0, 8)}@${domain}` });
    ids.push((await record(h, user, "signup")).id);
  }
  await until(
    h,
    () =>
      ids.every((id) =>
        (h.records.stream()?.retries() ?? []).some((row) => row.record_id === id && row.terminal),
      ),
    "every record terminal",
  );
  const lines = h.attention.filter((line) => line.startsWith("Source record failed for good"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("blocklisted domain");
});

const long = (c: string) => c.repeat(1000);

test("B166: a valid condition whose data comparisons are longer than PocketBase's 3,500-byte filter limit is decided, not refused: its sequence starts and the stream goes on", async () => {
  const h = await start();
  const data = { a: long("a"), b: long("b"), c: long("c"), d: long("d") };
  const seq = await conditioned(h, {
    event: h.ev("order_paid"),
    count: { gte: 1 },
    where: Object.fromEntries(Object.entries(data).map(([k, v]) => [`data.${k}`, v])),
  });
  const ana = await pb.user();
  const paid = await record(h, ana, "order_paid", data);
  await settled(h, paid);
  expect(outcome(h, paid)).toMatchObject({ kind: "written", started: 1 });
  const subscriber = (await linked(h, ana))?.id ?? 0;
  expect((await enrollmentsOf(h, subscriber)).map((e) => asBody<number>(e.sequence_id))).toEqual([
    seq.id,
  ]);
  expect(h.attention.some((line) => line.includes("Sequence trigger condition failed"))).toBe(
    false,
  );
  // The strict check still decides: the same data with one value changed does not count.
  const bob = await pb.user();
  const other = await record(h, bob, "order_paid", { ...data, d: long("e") });
  await settled(h, other);
  expect(outcome(h, other)).toMatchObject({ kind: "exits", started: 0 });
});

/** JSON nested `depth` levels deep. */
function nested(depth: number): JsonObject {
  let value: JsonObject = { leaf: 1 };
  for (let i = 1; i < depth; i++) {
    value = { x: value };
  }
  return value;
}

test("B166: an event nested 70 levels deep in a user's history skips only the condition's sequence; the record and the other sequence apply, and the stream goes on", async () => {
  const h = await start();
  const template = await h.f.template();
  const deep = await h.f.sequence({
    source: "external",
    trigger: {
      event: h.ev("order_paid"),
      condition: { event: h.ev("history"), count: { gte: 1 }, where: { "data.plan": "pro" } },
    },
    steps: [tx(template)],
  });
  const plain = await h.f.sequence({
    source: "external",
    trigger: { event: h.ev("order_paid") },
    steps: [tx(template)],
  });
  await resubscribed(h);
  const ana = await pb.user();
  await pb.event(
    ana.id,
    h.ev("history"),
    { plan: "pro", deep: nested(70) },
    { occurredAt: new Date(h.f.clock.now().getTime() - minute).toISOString() },
  );
  const paid = await record(h, ana, "order_paid");
  await settled(h, paid);
  expect(outcome(h, paid)).toMatchObject({ kind: "written", started: 1 });
  const subscriber = (await linked(h, ana))?.id ?? 0;
  expect((await enrollmentsOf(h, subscriber)).map((e) => asBody<number>(e.sequence_id))).toEqual([
    plain.id,
  ]);
  const lines = h.attention.filter((line) => line.includes("Sequence trigger condition failed"));
  expect(lines).toEqual([expect.stringContaining(`sequence ${deep.id}`)]);
  expect(lines[0]).toContain("nested deeper than 64 levels");
  // The stream goes on: the next record is handled.
  const bob = await pb.user();
  const next = await record(h, bob, "order_paid");
  await settled(h, next);
  expect(outcome(h, next)).toMatchObject({ kind: "written", started: 1 });
});

test("B166: a 200 HTML page on every source path after the adapter signed in refuses the stream, not one record: nothing terminal; answered again, the record is delivered once", async () => {
  const h = await start();
  const template = await h.f.template();
  await h.f.sequence({
    source: "external",
    trigger: { event: h.ev("order_paid") },
    steps: [tx(template)],
  });
  await resubscribed(h);
  // The stream's adapter holds a token from the session's catch-up; the record arrives on the open
  // connection, and the handler's recipients read gets the page.
  h.html.on = true;
  const ana = await pb.user();
  const paid = await record(h, ana, "order_paid");
  await until(h, () => h.attention.some((line) => line.includes("not JSON")), "the refusal");
  expect(h.records.stream()?.retries()).toEqual([]);
  expect(h.outcomes.some((o) => o.record === paid.id)).toBe(false);
  expect(await linked(h, ana)).toBeNull();

  h.html.on = false;
  await live(h);
  await handled(h, paid);
  expect((await linked(h, ana))?.email).toBe(emailOf(ana));
  expect(h.outcomes.filter((o) => o.record === paid.id)).toHaveLength(1);
  expect(h.records.stream()?.retries()).toEqual([]);
});
