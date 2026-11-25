// B150b (15-external-sources section 4, D169 amended, D171): the realtime stream against the real
// PocketBase 0.40.5 binary: live delivery, catch-up after a disconnect, the lookback, the forced
// and idle closes, resets, refused connects, topic split and re-subscribe, the retry queue,
// restart and a new source. The one transport fault the binary cannot produce on demand, a
// connection reset, comes from `stream-proxy.ts`, which forwards bytes unchanged.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { createPocketBaseSource } from "@/sources/pocketbase";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import { RETRY_WINDOW_MS } from "@/sources/stream";
import { streamEventNames } from "@/sources/stream-names";
import { sourceConfig, startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase } from "@/test/sources/pocketbase";
import { openGuard, startStream } from "@/test/sources/stream-fixture";
import type { StreamFixture } from "@/test/sources/stream-fixture";
import { startCutProxy } from "@/test/sources/stream-proxy";
import type { CutProxy } from "@/test/sources/stream-proxy";

setDefaultTimeout(60_000);

let pb: PocketBase;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  pb = await startPocketBase();
  // A second events collection whose `created` is a plain date the test sets, for records that
  // commit out of order (the binary's autodate cannot be set).
  await pb.api("POST", "/api/collections", {
    name: "manual_events",
    type: "base",
    listRule: '@request.auth.collectionName = "services"',
    viewRule: '@request.auth.collectionName = "services"',
    fields: [
      { name: "user", type: "relation", collectionId: "_pb_users_auth_", maxSelect: 1 },
      { name: "name", type: "text" },
      { name: "data", type: "json" },
      { name: "occurredAt", type: "date" },
      { name: "created", type: "date" },
    ],
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

afterAll(async () => {
  await pb?.close();
});

/** A unique event name per test, so tests on one PocketBase never see each other's records. */
const unique = (label: string) => `${label}_${crypto.randomUUID().slice(0, 8)}`;

function config(url = pb.url, over: Partial<PocketBaseConfig> = {}): PocketBaseConfig {
  return { ...sourceConfig(url, pb.service), ...over };
}

function stream(options: Parameters<typeof startStream>[0]): StreamFixture {
  const fixture = startStream(options);
  cleanups.push(() => fixture.close());
  return fixture;
}

function proxy(): CutProxy {
  const cut = startCutProxy(pb.port);
  cleanups.push(() => cut.stop());
  return cut;
}

/** No users collection: the event tests see only events. */
const eventsOnly = (url?: string) => config(url, { users: { collection: "", leavingFilter: "" } });

/** A PocketBase record ID chosen ahead of the record. */
const recordId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(15)), (byte) =>
    "abcdefghijklmnopqrstuvwxyz0123456789".charAt(byte % 36),
  ).join("");

/** Now plus `offsetMs`, as a PocketBase date field takes it. */
const stamp = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const sorted = (ids: Iterable<string>) => [...ids].sort();

const REFUSED = "Source stream refused by the source: check the source settings: ";

/** A catch-up (or retry) read of the events collection. */
const eventReads = (s: StreamFixture) =>
  s.requests.filter((line) => line.startsWith("GET /api/collections/events/records?")).length;

/** A fresh events collection (no key field), so a test may change its schema alone. */
async function eventsCollection() {
  const name = unique("ev");
  const rule = '@request.auth.collectionName = "services"';
  await pb.api("POST", "/api/collections", {
    name,
    type: "base",
    listRule: rule,
    viewRule: rule,
    fields: [
      { name: "user", type: "relation", collectionId: "_pb_users_auth_", maxSelect: 1 },
      { name: "name", type: "text" },
      { name: "data", type: "json" },
      { name: "occurredAt", type: "date" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
  });
  const settings = config(pb.url, {
    events: { ...config().events, collection: name, key: "" },
    users: { collection: "", leavingFilter: "" },
  });
  return { name, settings };
}

/** Minutes of the fixture's clock since `start`. */
const minutesSince = (s: StreamFixture, start: number) =>
  (s.clock.now().getTime() - start) / 60_000;

test("live delivery: subscribed names arrive once, others never; a user leaving arrives", async () => {
  const signup = unique("signup");
  const s = stream({ config: config(), names: () => [signup] });
  await s.live();
  const user = await pb.user();
  const a = await pb.event(user.id, signup, { plan: "pro" });
  const ignored = await pb.event(user.id, unique("other"));
  const b = await pb.event(user.id, signup);
  await s.until(() => s.eventIds().length === 2, "two events");
  expect(s.eventIds()).toEqual([a.id, b.id]);
  expect(s.attempts.has(ignored.id)).toBe(false);
  // The users topic: a user matching the leaving filter.
  await pb.update("users", user.id, { deletedAt: new Date().toISOString() });
  await s.until(() => s.handled.some((entry) => entry.kind === "user"), "the user leaving");
  expect(s.handled.filter((entry) => entry.kind === "user").map((entry) => entry.id)).toEqual([
    user.id,
  ]);
  expect(s.attention).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("a new source ignores history; a restart resumes from its marker", async () => {
  const name = unique("history");
  const user = await pb.user();
  const old = await pb.event(user.id, name);
  // PocketBase stamps `created` with its own clock and its Date header has whole seconds: the
  // history must be a second older than the first connection.
  await Bun.sleep(1100);
  const first = stream({ config: eventsOnly(), names: () => [name] });
  await first.live();
  const live = await pb.event(user.id, name);
  await first.until(() => first.eventIds().length === 1, "the live event");
  expect(first.eventIds()).toEqual([live.id]);
  expect(first.attempts.has(old.id)).toBe(false);
  // Stopped: records created meanwhile arrive at the next start, once; earlier ones do not repeat.
  await first.stop();
  cleanups.pop();
  cleanups.push(() => rmSync(first.dir, { recursive: true, force: true }));
  const meanwhile = [await pb.event(user.id, name), await pb.event(user.id, name)];
  const second = stream({ config: eventsOnly(), names: () => [name], dir: first.dir });
  await second.live();
  await second.until(() => second.eventIds().length === 2, "the records created while stopped");
  expect(sorted(second.eventIds())).toEqual(sorted(meanwhile.map((record) => record.id)));
});

test("a reset mid-stream: records created while disconnected arrive, none twice, no attention", async () => {
  const name = unique("reset");
  const cut = proxy();
  const s = stream({ config: eventsOnly(cut.url), names: () => [name] });
  await s.live();
  const user = await pb.user();
  const before = await pb.event(user.id, name);
  await s.until(() => s.eventIds().length === 1, "the first event");
  const sessions = s.stream.state().sessions;
  cut.cut();
  // The stream notices at once (a reset) and waits to reconnect on the clock, which `until`
  // moves only once these records exist.
  const meanwhile: Array<string> = [];
  for (let i = 0; i < 5; i++) {
    meanwhile.push((await pb.event(user.id, name)).id);
  }
  await s.until(() => s.stream.state().sessions > sessions, "a reconnect");
  await s.live();
  const after = await pb.event(user.id, name);
  await s.until(() => s.eventIds().length === 7, "every event");
  expect(sorted(s.eventIds())).toEqual(sorted([before.id, ...meanwhile, after.id]));
  expect(new Set(s.eventIds()).size).toBe(7);
  expect(s.attention).toEqual([]);
});

test("a reset mid-catch-up: the catch-up starts over, none lost, none twice, no attention", async () => {
  const name = unique("midcatch");
  const cut = proxy();
  const s = stream({ config: eventsOnly(cut.url), names: () => [name], tuning: { pageSize: 5 } });
  await s.live();
  const user = await pb.user();
  const first = await pb.event(user.id, name);
  await s.until(() => s.eventIds().length === 1, "the first event");
  // Cut the connection, then cut again when the catch-up asks for its third page.
  let pages = 0;
  cut.cutWhen((line) => {
    if (line.startsWith("GET /api/collections/events/records?") && line.includes("created")) {
      pages++;
      return pages === 3;
    }
    return false;
  });
  cut.cut();
  const meanwhile: Array<string> = [];
  for (let i = 0; i < 23; i++) {
    meanwhile.push((await pb.event(user.id, name)).id);
  }
  await s.until(() => s.eventIds().length === 24, "every event", 40_000);
  await s.live();
  expect(pages).toBeGreaterThan(3);
  expect(sorted(s.eventIds())).toEqual(sorted([first.id, ...meanwhile]));
  expect(new Set(s.eventIds()).size).toBe(24);
  expect(s.attention).toEqual([]);
});

test("out-of-order commits inside the lookback are caught up; older ones are not", async () => {
  const name = unique("order");
  const cut = proxy();
  const manual = config(cut.url, {
    events: { ...config().events, collection: "manual_events", key: "" },
    users: { collection: "", leavingFilter: "" },
  });
  const s = stream({ config: manual, names: () => [name] });
  await s.live();
  const user = await pb.user();
  const create = (offsetMs: number) =>
    pb.create("manual_events", {
      user: user.id,
      name,
      occurredAt: stamp(0),
      created: stamp(offsetMs),
    });
  const newest = await create(60_000);
  await s.until(() => s.eventIds().length === 1, "the newest record");
  cut.cut();
  // Committed after the newest, but stamped earlier: 5 s inside the 15 s lookback, 60 s outside.
  const inside = await create(55_000);
  const outside = await create(0);
  await s.until(() => s.eventIds().length === 2, "the record inside the lookback");
  await s.live();
  expect(s.eventIds()).toEqual([newest.id, inside.id]);
  expect(s.attempts.has(outside.id)).toBe(false);
});

test("the 30-minute forced close and the idle close are routine: reconnect and catch up", async () => {
  const name = unique("age");
  const s = stream({ config: eventsOnly(), names: () => [name], tuning: { idleMs: 3_600_000 } });
  await s.live();
  const user = await pb.user();
  const a = await pb.event(user.id, name);
  await s.until(() => s.eventIds().length === 1, "the first event");
  // Injected clock: 30 minutes later the client closes the connection itself.
  s.clock.advance(30 * 60_000);
  await s.until(() => s.stream.state().sessions === 2, "the forced close");
  await s.live();
  const b = await pb.event(user.id, name);
  await s.until(() => s.eventIds().length === 2, "the second event");
  // A connection with no byte for the idle limit (PocketBase's is 5 minutes) is closed too.
  const idle = stream({ config: eventsOnly(), names: () => [name] });
  await idle.live();
  idle.clock.advance(5 * 60_000 + 30_000);
  await idle.until(() => idle.stream.state().sessions === 2, "the idle close");
  await idle.live();
  expect(s.eventIds()).toEqual([a.id, b.id]);
  expect([...s.attention, ...idle.attention]).toEqual([]);
});

test("15 minutes of refused connects write one attention line; connecting again clears it", async () => {
  const name = unique("refused");
  const cut = proxy();
  cut.cutWhen(() => true);
  const s = stream({ config: eventsOnly(cut.url), names: () => [name] });
  const minutes = () => (s.clock.now().getTime() - Date.parse("2026-01-02T03:04:05Z")) / 60_000;
  await s.until(() => minutes() >= 14, "14 minutes of failed connects", 30_000, 10_000);
  expect(s.attention).toEqual([]);
  await s.until(() => minutes() >= 30, "30 minutes of failed connects", 30_000, 10_000);
  expect(s.attention).toHaveLength(1);
  expect(s.attention[0]).toStartWith("Source stream cannot connect: retrying: ");
  cut.cutWhen(undefined);
  await s.live();
  const user = await pb.user();
  const record = await pb.event(user.id, name);
  await s.until(() => s.eventIds().length === 1, "an event once connected");
  expect(s.eventIds()).toEqual([record.id]);
  expect(s.attention).toHaveLength(1);
});

test("a permanent refusal (a wrong password) writes one attention line at once", async () => {
  const s = stream({
    config: { ...eventsOnly(), password: "not-the-password" },
    names: () => [unique("wrong")],
  });
  await s.until(() => s.attention.length === 1, "the refusal");
  // Retries keep failing (each 5 minutes) without another line.
  for (let i = 0; i < 3; i++) {
    await s.until(() => s.stream.state().state === "waiting", "a wait");
    s.clock.advance(5 * 60_000);
    await Bun.sleep(50);
  }
  expect(s.attention).toHaveLength(1);
  expect(s.attention[0]).toStartWith(
    "Source stream refused by the source: check the source settings: ",
  );
});

test("a catch-up refused after a subscription writes one line until the stream gets live again", async () => {
  // PocketBase takes a realtime filter on a field that does not exist; the catch-up list is a 400.
  const events = await eventsCollection();
  await pb.renameField(events.name, "name", "label");
  const s = stream({ config: events.settings, names: () => [unique("field")] });
  const start = s.clock.now().getTime();
  await s.until(() => minutesSince(s, start) >= 25, "25 minutes of refusals", 30_000, 60_000);
  expect(s.requests.filter((line) => line.startsWith("POST /api/realtime")).length).toBeGreaterThan(
    4,
  );
  expect(s.attention).toHaveLength(1);
  expect(s.attention[0]).toStartWith(REFUSED);
  // Fixed: the stream gets live, and its warnings start over.
  await pb.renameField(events.name, "label", "name");
  await s.until(() => s.stream.state().state === "live", "live once fixed", 30_000, 60_000);
  // A later failure (the field goes again; the 30-minute close reconnects) writes one line again.
  await pb.renameField(events.name, "name", "label");
  s.clock.advance(30 * 60_000);
  await s.until(() => s.attention.length === 2, "the second refusal", 30_000, 60_000);
  const again = s.clock.now().getTime();
  await s.until(() => minutesSince(s, again) >= 25, "25 more minutes", 30_000, 60_000);
  expect(s.attention).toHaveLength(2);
  expect(s.attention[1]).toStartWith(REFUSED);
});

test("a record lacking a configured field refuses the stream: nothing consumed, one line", async () => {
  const events = await eventsCollection();
  await pb.renameField(events.name, "data", "payload");
  const name = unique("mapping");
  const s = stream({ config: events.settings, names: () => [name] });
  await s.live();
  const user = await pb.user();
  const ids: Array<string> = [];
  for (let i = 0; i < 5; i++) {
    const record = await pb.create(events.name, {
      user: user.id,
      name,
      occurredAt: stamp(0),
      payload: { i },
    });
    ids.push(record.id);
  }
  await s.until(() => s.attention.length === 1, "the refusal");
  const start = s.clock.now().getTime();
  await s.until(() => minutesSince(s, start) >= 20, "20 minutes of refusals", 30_000, 60_000);
  expect(s.attention).toHaveLength(1);
  expect(s.attention[0]).toStartWith(REFUSED);
  expect(s.attention[0]).toContain('no field "data"');
  expect(s.attempts.size).toBe(0);
  expect(s.stream.retries()).toEqual([]);
  expect(s.stream.seenCount()).toBe(0);
  // The mapping fits again: every record arrives, once.
  await pb.renameField(events.name, "payload", "data");
  await s.until(() => s.eventIds().length === 5, "every record", 30_000, 60_000);
  await s.until(() => s.stream.state().state === "live", "live", 30_000, 60_000);
  expect(sorted(s.eventIds())).toEqual(sorted(ids));
  expect(s.attention).toHaveLength(1);
});

test("terminal records write one line per cause until a record is handled again", async () => {
  const name = unique("cap");
  const s = stream({ config: eventsOnly(), names: () => [name] });
  await s.live();
  const user = await pb.user();
  const failing = [recordId(), recordId(), recordId()];
  for (const id of failing) {
    s.fail.set(id, ["permanent"]);
    await pb.event(user.id, name, {}, { id });
  }
  const ok = await pb.event(user.id, name);
  await s.until(() => s.eventIds().includes(ok.id), "the record after the failures");
  expect(s.attention).toHaveLength(1);
  expect(s.attention[0]).toContain(failing[0]);
  // A record was handled since: the same cause writes a line again.
  const later = recordId();
  s.fail.set(later, ["permanent"]);
  await pb.event(user.id, name, {}, { id: later });
  await s.until(() => s.stream.retries().length === 4, "the fourth terminal record");
  expect(s.attention).toHaveLength(2);
  expect(s.attention[1]).toContain(later);
  expect(s.stream.retries().every((row) => row.terminal === 1n)).toBe(true);
});

test("a live buffer past its limit is dropped and caught up: none lost, none twice", async () => {
  const name = unique("buffer");
  // A realtime message for one record is a few hundred characters: a few fit.
  const s = stream({ config: eventsOnly(), names: () => [name], tuning: { bufferLimit: 2000 } });
  await s.live();
  const user = await pb.user();
  // The handler is slow on the first record, so what arrives meanwhile waits in the buffer.
  const slow = recordId();
  const held = Promise.withResolvers<void>();
  s.hold.set(slow, held.promise);
  await pb.event(user.id, name, {}, { id: slow });
  await s.until(() => s.attempts.has(slow), "the slow record");
  const reads = eventReads(s);
  const sessions = s.stream.state().sessions;
  const meanwhile: Array<string> = [];
  for (let i = 0; i < 20; i++) {
    meanwhile.push((await pb.event(user.id, name, { i })).id);
  }
  // Real time for the messages to reach the buffer (no clock is involved).
  await Bun.sleep(300);
  held.resolve();
  await s.until(() => s.eventIds().length === 21, "every record");
  await s.live();
  expect(sorted(s.eventIds())).toEqual(sorted([slow, ...meanwhile]));
  expect(new Set(s.eventIds()).size).toBe(21);
  // Recovered by a catch-up on the same connection.
  expect(eventReads(s)).toBeGreaterThan(reads);
  expect(s.stream.state().sessions).toBe(sessions);
  expect(s.attention).toEqual([]);
});

test("an oversized live message is dropped and its record caught up", async () => {
  const name = unique("oversized");
  const s = stream({ config: eventsOnly(), names: () => [name], tuning: { maxLine: 2000 } });
  await s.live();
  const user = await pb.user();
  const reads = eventReads(s);
  const big = await pb.event(user.id, name, { blob: "x".repeat(5000) });
  await s.until(() => s.eventIds().length === 1, "the large record");
  await s.live();
  expect(s.eventIds()).toEqual([big.id]);
  expect(eventReads(s)).toBeGreaterThan(reads);
  expect(s.attention).toEqual([]);
});

test("topics split past 2,500 characters; a name change re-subscribes", async () => {
  // 60 names of about 60 characters: one topic would be far over PocketBase's limit.
  const prefix = unique("split");
  const names = Array.from({ length: 60 }, (_, i) => `${prefix}_${"x".repeat(40)}_${i}`);
  let subscribed = [...names];
  const s = stream({ config: eventsOnly(), names: () => subscribed });
  await s.live();
  // One subscription request carrying several topics.
  expect(s.requests.filter((line) => line.startsWith("POST /api/realtime"))).toHaveLength(1);
  const topics = createPocketBaseSource({
    config: eventsOnly(),
    clock: s.clock,
    guard: openGuard,
  }).stream.eventTopics(names);
  expect(topics.length).toBeGreaterThan(1);
  expect(topics.every(({ topic }) => topic.length <= 2500)).toBe(true);
  expect(topics.flatMap((topic) => topic.names)).toEqual(names);
  const user = await pb.user();
  const first = await pb.event(user.id, names[0]!);
  const last = await pb.event(user.id, names[59]!);
  await s.until(() => s.eventIds().length === 2, "events of the first and the last topic");
  expect(sorted(s.eventIds())).toEqual(sorted([first.id, last.id]));
  // A new name: the periodic check (15 s on the clock) or `refresh` re-subscribes.
  const late = unique("late");
  subscribed = [...names, late];
  const sessions = s.stream.state().sessions;
  s.clock.advance(15_000);
  await s.until(() => s.stream.state().sessions > sessions, "the re-subscription");
  await s.live();
  const record = await pb.event(user.id, late);
  await s.until(() => s.eventIds().length === 3, "the new name's event");
  expect(s.eventIds().at(-1)).toBe(record.id);
  // A name dropped is no longer received.
  subscribed = [late];
  s.stream.refresh();
  await s.until(() => s.stream.state().sessions > sessions + 1, "the second re-subscription");
  await s.live();
  const dropped = await pb.event(user.id, names[0]!);
  const kept = await pb.event(user.id, late);
  await s.until(() => s.eventIds().length === 4, "the kept name's event");
  expect(s.eventIds().at(-1)).toBe(kept.id);
  expect(s.attempts.has(dropped.id)).toBe(false);
});

test("the retry queue: a transient failure retries later without holding the stream up", async () => {
  const name = unique("retry");
  const s = stream({ config: eventsOnly(), names: () => [name] });
  await s.live();
  const user = await pb.user();
  // The failures are set before the record exists: it may arrive at once.
  const failing = { id: recordId() };
  s.fail.set(failing.id, ["transient", "transient"]);
  await pb.event(user.id, name, {}, { id: failing.id });
  const next = await pb.event(user.id, name);
  // The stream goes on past the failed record.
  await s.until(() => s.eventIds().includes(next.id), "the next event");
  expect(s.eventIds()).toEqual([next.id]);
  expect(s.stream.retries()).toMatchObject([
    { kind: "event", record_id: failing.id, terminal: 0n },
  ]);
  // The first retry is due a minute later and fails again; the second (two minutes on) works.
  s.clock.advance(60_000);
  s.stream.wakeRetries();
  await s.until(() => s.attempts.get(failing.id) === 2, "the first retry");
  await Bun.sleep(50);
  expect(s.stream.retries()).toHaveLength(1);
  s.clock.advance(120_000);
  s.stream.wakeRetries();
  await s.until(() => s.eventIds().includes(failing.id), "the second retry");
  await s.until(() => s.stream.retries().length === 0, "the queue to empty");
  expect(s.attention).toEqual([]);
  expect(s.eventIds()).toEqual([next.id, failing.id]);
});

test("the retry queue: a permanent failure, and 72 hours of transient ones, are terminal", async () => {
  const name = unique("terminal");
  const s = stream({ config: eventsOnly(), names: () => [name] });
  await s.live();
  const user = await pb.user();
  const permanent = { id: recordId() };
  s.fail.set(permanent.id, ["permanent"]);
  await pb.event(user.id, name, {}, { id: permanent.id });
  const transient = { id: recordId() };
  s.fail.set(
    transient.id,
    Array.from({ length: 200 }, () => "transient" as const),
  );
  await pb.event(user.id, name, {}, { id: transient.id });
  const after = await pb.event(user.id, name);
  await s.until(() => s.eventIds().includes(after.id), "the event after both");
  expect(s.attention).toHaveLength(1);
  expect(s.attention[0]).toStartWith("Source record failed for good: ");
  expect(s.attention[0]).toContain(permanent.id);
  // Transient failures back off (capped at an hour) until 72 hours have passed.
  const start = s.clock.now().getTime();
  while (s.clock.now().getTime() - start <= RETRY_WINDOW_MS + 3_600_000) {
    s.clock.advance(3_600_000);
    s.stream.wakeRetries();
    const tries = s.attempts.get(transient.id) ?? 0;
    await s.until(
      () => (s.attempts.get(transient.id) ?? 0) > tries || s.attention.length === 2,
      "a retry",
    );
    if (s.attention.length === 2) {
      break;
    }
  }
  await s.until(() => s.attention.length === 2, "the terminal line");
  expect(s.attention[1]).toContain(transient.id);
  const rows = s.stream.retries();
  expect(rows.map((row) => [row.record_id, row.terminal])).toEqual([
    [permanent.id, 1n],
    [transient.id, 1n],
  ]);
  expect(s.eventIds()).toEqual([after.id]);
});

test("the retry queue: a settings mismatch waits past 72 hours and does not use up the window", async () => {
  const events = await eventsCollection();
  const name = unique("retrymap");
  const s = stream({ config: events.settings, names: () => [name] });
  await s.live();
  const user = await pb.user();
  const id = recordId();
  s.fail.set(
    id,
    Array.from({ length: 200 }, () => "transient" as const),
  );
  await pb.create(events.name, { id, user: user.id, name, occurredAt: stamp(0), data: {} });
  await s.until(() => s.stream.retries().length === 1, "the queued record");
  const attemptsOf = () => s.stream.retries()[0]?.attempts ?? 0n;
  const retryAfter = async (ms: number) => {
    const tries = attemptsOf();
    s.clock.advance(ms);
    s.stream.wakeRetries();
    await s.until(() => attemptsOf() > tries, "a retry");
  };
  // Transient handler failures for 71 hours of the 72-hour window.
  const first = s.clock.now().getTime();
  while (s.clock.now().getTime() - first < RETRY_WINDOW_MS - 3_600_000) {
    await retryAfter(3_600_000);
  }
  const handlerCalls = s.attempts.get(id);
  // The configured data field goes missing: the next retry, past the window, meets the
  // mismatch, and so does every retry for 72 hours more.
  await pb.renameField(events.name, "data", "payload");
  const start = s.clock.now().getTime();
  while (s.clock.now().getTime() - start <= RETRY_WINDOW_MS + 3_600_000) {
    await retryAfter(2 * 3_600_000);
  }
  expect(s.attempts.get(id)).toBe(handlerCalls);
  expect(s.stream.retries()).toMatchObject([{ record_id: id, terminal: 0n }]);
  expect(s.stream.retries()[0]?.last_error).toContain('no field "data"');
  expect(s.attention.some((line) => line.startsWith("Source record failed for good"))).toBe(false);
  expect(s.attention.some((line) => line.startsWith(REFUSED))).toBe(true);
  // The field is back. The window started again at the last mismatch, so one more transient
  // failure still retries, and the next retry delivers the record once.
  await pb.renameField(events.name, "payload", "data");
  s.fail.set(id, ["transient"]);
  for (const handled of [1, 2].map((n) => (handlerCalls ?? 0) + n)) {
    s.clock.advance(3_600_000);
    s.stream.wakeRetries();
    await s.until(() => s.attempts.get(id) === handled, `handler call ${handled}`);
  }
  await s.until(() => s.stream.retries().length === 0, "the queue to empty");
  expect(s.eventIds()).toEqual([id]);
  expect(s.attention.some((line) => line.startsWith("Source record failed for good"))).toBe(false);
});

test("the subscribed names: active triggers, active or paused exits, and grant rules", () => {
  const sequences = [
    { status: "active", trigger: { event: "signup" }, exit_on: ["churned"] },
    { status: "paused", trigger: { event: "paused_trigger" }, exit_on: ["paused_exit"] },
  ];
  const store = {
    list(filter: { status: string; page: number; perPage: number }) {
      const rows = sequences.filter((row) => row.status === filter.status);
      return {
        results: filter.page === 1 ? rows : [],
      };
    },
  };
  const settings = { "source.grant_lists": [{ event: "order_paid", where: {}, lists: [1] }] };
  const names = streamEventNames(store, () => settings);
  expect(names()).toEqual(["churned", "order_paid", "paused_exit", "signup"]);
});
