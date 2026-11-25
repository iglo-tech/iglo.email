// B141 (14-projects sections 7 and 15, D155): the outbox's claim split by kind, through POST /api/tx,
// the send log and the test SMTP sink, on the injected clock. Transactional rows are claimed at once
// and take the next start; marketing rows are claimed only against the dispatcher's grant, and a
// synchronous marketing call waits at most the horizon plus 5 s for one.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { HORIZON_MS } from "@/messaging/dispatcher";
import { txFixture } from "@/test/tx/fixture";
import { asBody } from "@/test/read-body";

setDefaultTimeout(30_000);

type Fixture = Awaited<ReturnType<typeof txFixture>>;
let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const turns = async (count = 10) => {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

/** A single opt-in list with `count` confirmed members; their addresses. */
async function audience(fixture: Fixture, name: string, count: number) {
  const list = await fixture.json("/api/lists", "POST", {
    name,
    type: "public",
    optin: "single",
  });
  expect(list.status).toBe(200);
  const id = asBody<number>(list.body.data.id);
  const emails: Array<string> = [];
  for (let i = 0; i < count; i++) {
    const email = `${name}-${i}@example.test`;
    await fixture.subscriber(email, `${name} ${i}`, {
      lists: [id],
      preconfirm_subscriptions: true,
    });
    emails.push(email);
  }
  return { id, emails };
}

/** The send log's rows by kind and status. */
async function statuses(fixture: Fixture) {
  const page = await fixture.json("/api/sends?per_page=100");
  expect(page.status).toBe(200);
  const rows = asBody<Array<{ kind: string; status: string }>>(page.body.data.results);
  const count = (kind: string, status: string) =>
    rows.filter((row) => row.kind === kind && row.status === status).length;
  return { rows, count };
}

test("a mixed batch claims transactional rows at once and marketing rows only against grants", async () => {
  // Rate 1: the horizon holds two slots, and a waiting transactional start takes one of them.
  f = await txFixture({ rate: () => 1 });
  const fixture = f;
  const template = await fixture.template("<p>Hello</p>", "Hello");
  const people = await audience(fixture, "tx", 3);
  const readers = await audience(fixture, "news", 5);
  const marketing = await fixture.tx({
    subscriber_emails: readers.emails,
    template_id: template,
    kind: "marketing",
    list_id: readers.id,
    async: true,
  });
  expect(marketing.status).toBe(200);
  const transactional = await fixture.tx({
    subscriber_emails: people.emails,
    template_id: template,
    async: true,
  });
  expect(transactional.status).toBe(200);
  // The outbox's loops run; no injected time passes, so no message starts yet.
  const end = Date.now() + 10_000;
  for (;;) {
    await turns();
    if ((await statuses(fixture)).count("transactional", "sending") === 3) {
      break;
    }
    if (Date.now() > end) {
      throw new Error("the transactional rows were not claimed");
    }
    await Bun.sleep(5);
  }
  // Every transactional row is claimed at once; of the marketing rows, at most the two the horizon
  // holds, granted before the transactional rows came, and the rest stay queued with no lease.
  let now = await statuses(fixture);
  expect(now.count("marketing", "sending")).toBeLessThanOrEqual(2);
  expect(now.count("marketing", "queued")).toBeGreaterThanOrEqual(3);
  // Through the whole drain, at most the horizon's two marketing rows are claimed at a time.
  let most = 0;
  while (fixture.sink.messages.length < 8) {
    if (Date.now() > end + 10_000) {
      throw new Error(`drained ${fixture.sink.messages.length} of 8`);
    }
    fixture.clock.advance(100);
    await turns();
    await Bun.sleep(2);
    now = await statuses(fixture);
    most = Math.max(most, now.count("marketing", "sending"));
    expect(now.count("marketing", "sending")).toBeLessThanOrEqual(2);
  }
  // The three transactional messages started first.
  expect(
    fixture.sink.messages
      .slice(0, 3)
      .map((m) => m.to[0] ?? "")
      .sort((x, y) => x.localeCompare(y)),
  ).toEqual(people.emails);
  await turns();
  expect(most).toBeGreaterThan(0);
});

test("a synchronous marketing call under a backlog answers queued within the horizon plus 5 s, and is sent later", async () => {
  // Held: no marketing or campaign slot is granted, as under a backlog or B145's guard.
  let held = true;
  f = await txFixture({ held: () => held });
  const fixture = f;
  const template = await fixture.template("<p>Hello</p>", "Hello");
  const readers = await audience(fixture, "news", 1);
  let answered = false;
  const call = fixture
    .tx({
      subscriber_emails: readers.emails,
      template_id: template,
      kind: "marketing",
      list_id: readers.id,
    })
    .then((response) => {
      answered = true;
      return response;
    });
  // A transactional call is never held.
  const people = await audience(fixture, "tx", 1);
  const transactional = await fixture.tx({
    subscriber_emails: people.emails,
    template_id: template,
  });
  expect(transactional.body.data.sends[0].status).toBe("sent");
  const limit = HORIZON_MS + 5000;
  for (let waited = 0; waited < limit - 100; waited += 100) {
    fixture.clock.advance(100);
    await turns();
  }
  expect(answered).toBe(false);
  fixture.clock.advance(100);
  const response = await call;
  expect(response.status).toBe(200);
  expect(response.body.data.sends[0].status).toBe("queued");
  expect(fixture.sink.messages.map((m) => m.to[0])).toEqual(people.emails);
  // The guard lifts: the outbox sends the queued row.
  held = false;
  fixture.emailer.dispatcher.wake();
  const end = Date.now() + 10_000;
  while (!fixture.sink.messages.some((m) => m.to[0] === readers.emails[0])) {
    if (Date.now() > end) {
      throw new Error("the queued marketing row was not sent");
    }
    fixture.clock.advance(1000);
    await turns();
    await Bun.sleep(2);
  }
  const id = asBody<number>(response.body.data.sends[0].id);
  const end2 = Date.now() + 10_000;
  for (;;) {
    const row = await fixture.json(`/api/sends/${id}`);
    if (row.body.data.status === "sent") {
      break;
    }
    if (Date.now() > end2) {
      throw new Error(`row ${row.body.data.status}`);
    }
    await turns();
  }
});

test("a synchronous marketing call behind a real transactional backlog answers queued within the horizon plus 5 s, and is sent later", async () => {
  // B149b (B141 r1): no hold. At rate 1 the horizon holds two slots, and 12 waiting transactional
  // starts fill it for longer than the call's bound: 7 of them start in 7 s.
  f = await txFixture({ rate: () => 1 });
  const fixture = f;
  const template = await fixture.template("<p>Hello</p>", "Hello");
  const people = await audience(fixture, "tx", 12);
  const readers = await audience(fixture, "news", 1);
  const backlog = await fixture.tx({
    subscriber_emails: people.emails,
    template_id: template,
    async: true,
  });
  expect(backlog.status).toBe(200);
  const claimed = Date.now() + 10_000;
  while ((await statuses(fixture)).count("transactional", "sending") < 2) {
    if (Date.now() > claimed) {
      throw new Error("the transactional backlog was not claimed");
    }
    await turns();
    await Bun.sleep(5);
  }
  let answered = false;
  const call = fixture
    .tx({
      subscriber_emails: readers.emails,
      template_id: template,
      kind: "marketing",
      list_id: readers.id,
    })
    .then((response) => {
      answered = true;
      return response;
    });
  // The call has queued its row and waits for a grant before the injected time moves.
  const queued = Date.now() + 10_000;
  while ((await statuses(fixture)).count("marketing", "queued") < 1) {
    if (Date.now() > queued) {
      throw new Error("the marketing row was not queued");
    }
    await turns();
    await Bun.sleep(5);
  }
  await Bun.sleep(50);
  const limit = HORIZON_MS + 5000;
  for (let waited = 0; waited < limit - 100; waited += 100) {
    fixture.clock.advance(100);
    await turns();
  }
  expect(answered).toBe(false);
  fixture.clock.advance(100);
  const response = await call;
  expect(response.status).toBe(200);
  expect(response.body.data.sends[0].status).toBe("queued");
  // The backlog drains, and the outbox's marketing loop sends the queued row after it.
  const end = Date.now() + 20_000;
  while (!fixture.sink.messages.some((m) => m.to[0] === readers.emails[0])) {
    if (Date.now() > end) {
      throw new Error(`the queued marketing row was not sent: ${fixture.sink.messages.length}`);
    }
    fixture.clock.advance(1000);
    await turns();
    await Bun.sleep(2);
  }
  const id = asBody<number>(response.body.data.sends[0].id);
  const settled = Date.now() + 10_000;
  for (;;) {
    const row = await fixture.json(`/api/sends/${id}`);
    if (row.body.data.status === "sent") {
      break;
    }
    if (Date.now() > settled) {
      throw new Error(`row ${row.body.data.status}`);
    }
    await turns();
  }
  // It started behind the transactional backlog's first messages, not ahead of all of them.
  const order = fixture.sink.messages.map((m) => m.to[0] ?? "");
  expect(order.indexOf(readers.emails[0]!)).toBeGreaterThan(0);
});
