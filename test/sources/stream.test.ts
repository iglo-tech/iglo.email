// B150b (15-external-sources section 4, D169 amended, D171): the realtime stream against the real
// PocketBase 0.40.5 binary: live delivery, catch-up after a disconnect, the lookback, the forced
// and idle closes, resets, refused connects, topic split and re-subscribe, the retry queue,
// restart and a new source. The one transport fault the binary cannot produce on demand, a
// connection reset, comes from `stream-proxy.ts`, which forwards bytes unchanged.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { openDatabase } from "@/db/connection";
import { createPocketBaseSource } from "@/sources/pocketbase";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import { must } from "@/invariant";
import { RETRY_MAX_MS, RETRY_MIN_MS, RETRY_WINDOW_MS } from "@/sources/stream";
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
const CANNOT_CONNECT = "Source stream cannot connect: retrying: ";
const FAILED_FOR_GOOD = "Source record failed for good: ";

/**
 * The attention lines about one thing (B154): a test reads the lines of what it checks by what
 * they say, never by position, which another line (the stream's own) could take.
 */
const linesOf = (s: StreamFixture, prefix: string) =>
  s.attention.filter((line) => line.startsWith(prefix));

/**
 * The queue's first row is due one backoff (a minute doubling per attempt, capped at an hour)
 * after the attempt that just finished, which ran at the clock's time now (B153). With `id`, that
 * record's row instead.
 */
function expectBackoff(s: StreamFixture, id?: string) {
  const rows = s.stream.retries();
  const row = must(id ? rows.find((r) => r.record_id === id) : rows[0], "a queued row");
  const wait = Math.min(RETRY_MIN_MS * 2 ** (Number(row.attempts) - 1), RETRY_MAX_MS);
  expect(row.next_attempt_at).toBe(new Date(s.clock.now().getTime() + wait).toISOString());
}

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
  await s.advance(30 * 60_000);
  await s.until(() => s.stream.state().sessions === 2, "the forced close");
  await s.live();
  const b = await pb.event(user.id, name);
  await s.until(() => s.eventIds().length === 2, "the second event");
  // A connection with no byte for the idle limit (PocketBase's is 5 minutes) is closed too.
  const idle = stream({ config: eventsOnly(), names: () => [name] });
  await idle.live();
  await idle.advance(5 * 60_000 + 30_000);
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
  expect(linesOf(s, CANNOT_CONNECT)).toHaveLength(1);
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
  // Retries keep failing (each 5 minutes) without another line. Each try signs in once; the clock
  // moves again only once that try was refused and the stream waits (B155b: no real-time sleep).
  const signIns = () => s.requests.filter((line) => line.includes("/auth-with-password")).length;
  for (let i = 0; i < 3; i++) {
    await s.settle(() => s.stream.state().state === "waiting", "a wait");
    const before = signIns();
    await s.advance(5 * 60_000);
    await s.settle(
      () => signIns() > before && s.stream.state().state === "waiting",
      "the next refused try",
    );
  }
  expect(signIns()).toBe(4);
  expect(s.attention).toHaveLength(1);
  expect(linesOf(s, REFUSED)).toHaveLength(1);
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
  expect(linesOf(s, REFUSED)).toHaveLength(1);
  // Fixed: the stream gets live, and its warnings start over.
  await pb.renameField(events.name, "label", "name");
  await s.until(() => s.stream.state().state === "live", "live once fixed", 30_000, 60_000);
  // A later failure (the field goes again; the 30-minute close reconnects) writes one line again.
  await pb.renameField(events.name, "name", "label");
  await s.advance(30 * 60_000);
  await s.until(() => s.attention.length === 2, "the second refusal", 30_000, 60_000);
  const again = s.clock.now().getTime();
  await s.until(() => minutesSince(s, again) >= 25, "25 more minutes", 30_000, 60_000);
  expect(s.attention).toHaveLength(2);
  expect(linesOf(s, REFUSED)).toHaveLength(2);
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
  expect(linesOf(s, REFUSED)).toEqual([expect.stringContaining('no field "data"')]);
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
  expect(linesOf(s, FAILED_FOR_GOOD)).toEqual([expect.stringContaining(failing[0]!)]);
  // A record was handled since: the same cause writes a line again.
  const later = recordId();
  s.fail.set(later, ["permanent"]);
  await pb.event(user.id, name, {}, { id: later });
  await s.until(() => s.stream.retries().length === 4, "the fourth terminal record");
  expect(s.attention).toHaveLength(2);
  expect(linesOf(s, FAILED_FOR_GOOD)).toEqual([
    expect.stringContaining(failing[0]!),
    expect.stringContaining(later),
  ]);
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
  await s.advance(15_000);
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
  await s.retryAfter(60_000);
  expect(s.attempts.get(failing.id)).toBe(2);
  expect(s.stream.retries()).toHaveLength(1);
  expectBackoff(s);
  await s.retryAfter(120_000);
  expect(s.stream.retries()).toEqual([]);
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
  expect(linesOf(s, FAILED_FOR_GOOD)).toEqual([expect.stringContaining(permanent.id)]);
  // Transient failures back off (capped at an hour) until 72 hours have passed. Each retry runs
  // with the clock still, and the stream's own reconnects (the live connection goes idle at each
  // hour moved) answer before the clock moves again, so they write no line (B154).
  const start = s.clock.now().getTime();
  while (s.clock.now().getTime() - start <= RETRY_WINDOW_MS + 3_600_000) {
    await s.retryAfter(3_600_000);
    if (s.stream.retries().every((row) => row.terminal === 1n)) {
      break;
    }
    expectBackoff(s, transient.id);
  }
  expect(linesOf(s, FAILED_FOR_GOOD)).toEqual([
    expect.stringContaining(permanent.id),
    expect.stringContaining(transient.id),
  ]);
  expect(linesOf(s, CANNOT_CONNECT)).toEqual([]);
  expect(s.attention).toHaveLength(2);
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
  // Each retry runs with the clock still, and the next is due one backoff after it.
  const retryAfter = async (ms: number) => {
    await s.retryAfter(ms);
    expectBackoff(s);
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
  expect(s.stream.retries()).toMatchObject([{ record_id: id, terminal: 0n, waiting: 1n }]);
  expect(s.stream.retries()[0]?.last_error).toContain('no field "data"');
  expect(s.attention.some((line) => line.startsWith("Source record failed for good"))).toBe(false);
  expect(s.attention.some((line) => line.startsWith(REFUSED))).toBe(true);
  // The field is back. The window started again at the last mismatch, so one more transient
  // failure still retries, and the next retry delivers the record once.
  await pb.renameField(events.name, "payload", "data");
  s.fail.set(id, ["transient"]);
  await retryAfter(3_600_000);
  expect(s.attempts.get(id)).toBe((handlerCalls ?? 0) + 1);
  // A transient failure again: no longer waiting for the settings.
  expect(s.stream.retries()).toMatchObject([{ record_id: id, terminal: 0n, waiting: 0n }]);
  await s.retryAfter(3_600_000);
  expect(s.attempts.get(id)).toBe((handlerCalls ?? 0) + 2);
  expect(s.stream.retries()).toEqual([]);
  expect(s.eventIds()).toEqual([id]);
  expect(s.attention.some((line) => line.startsWith("Source record failed for good"))).toBe(false);
});

test("the retry queue: a re-read the source refuses waits past 72 hours, then delivers once", async () => {
  const events = await eventsCollection();
  const name = unique("retryread");
  const s = stream({ config: events.settings, names: () => [name] });
  await s.live();
  const user = await pb.user();
  const id = recordId();
  s.fail.set(id, ["transient"]);
  await pb.create(events.name, { id, user: user.id, name, occurredAt: stamp(0), data: {} });
  await s.until(() => s.stream.retries().length === 1, "the queued record");
  const handlerCalls = s.attempts.get(id);
  // The re-read filters on `occurredAt`: renamed, PocketBase refuses the read with a 400.
  await pb.renameField(events.name, "occurredAt", "when");
  const start = s.clock.now().getTime();
  while (s.clock.now().getTime() - start <= RETRY_WINDOW_MS + 3_600_000) {
    await s.retryAfter(2 * 3_600_000);
    expectBackoff(s);
  }
  expect(s.attempts.get(id)).toBe(handlerCalls);
  expect(s.stream.retries()).toMatchObject([{ record_id: id, terminal: 0n, waiting: 1n }]);
  expect(s.attention.some((line) => line.startsWith("Source record failed for good"))).toBe(false);
  expect(s.attention.filter((line) => line.startsWith(`${REFUSED}event ${id}:`))).toHaveLength(1);
  // The field is back: the next retry delivers the record, once.
  await pb.renameField(events.name, "when", "occurredAt");
  await s.retryAfter(3_600_000);
  expect(s.stream.retries()).toEqual([]);
  expect(s.attempts.get(id)).toBe((handlerCalls ?? 0) + 1);
  expect(s.eventIds()).toEqual([id]);
  expect(s.attention.some((line) => line.startsWith("Source record failed for good"))).toBe(false);
});

/** JSON nested `levels` objects deep (the adapter refuses past 64). */
function nested(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let i = 1; i < levels; i++) {
    value = { a: value };
  }
  return value;
}

/**
 * A fresh events collection whose IDs may be up to `max` characters: past the 100 the stream keys
 * (PocketBase refuses the characters the stream's pattern leaves out, so length is the one way).
 */
async function longIdEventsCollection(max = 120) {
  const events = await eventsCollection();
  const collection: { fields: Array<Record<string, unknown>> } = await pb.api(
    "GET",
    `/api/collections/${events.name}`,
  );
  const fields = collection.fields.map((field) =>
    field.name === "id" ? { ...field, min: 1, max } : field,
  );
  await pb.api("PATCH", `/api/collections/${events.name}`, { fields });
  return events;
}

test("B155b: a record nested past the limit is terminal with one line, live and in a catch-up", async () => {
  const name = unique("deep");
  const cut = proxy();
  const s = stream({ config: eventsOnly(cut.url), names: () => [name], tuning: { pageSize: 5 } });
  await s.live();
  const user = await pb.user();
  // B158: the two records can share a millisecond `created`, and the catch-up the deep message
  // starts reads in `(created, id)` order: with random IDs, `after` could come first in that order
  // and be delivered before the deep record is reached. The IDs make the deep record first either
  // way, so `after` delivered means the stream has gone past it.
  const live = await pb.event(user.id, name, nested(70), { id: `0${recordId().slice(1)}` });
  const after = await pb.event(user.id, name, {}, { id: `z${recordId().slice(1)}` });
  await s.until(() => s.eventIds().includes(after.id), "the record after the deep one");
  // Terminal before the stream goes on (a later catch-up's lookback must not be what finds it).
  expect(s.stream.retries()).toMatchObject([{ record_id: live.id, terminal: 1n }]);
  // Disconnected: a deep record among others, read by the catch-up's pages.
  cut.cut();
  const meanwhile: Array<string> = [];
  for (let i = 0; i < 4; i++) {
    meanwhile.push((await pb.event(user.id, name)).id);
  }
  const caught = await pb.event(user.id, name, nested(70));
  for (let i = 0; i < 4; i++) {
    meanwhile.push((await pb.event(user.id, name)).id);
  }
  await s.until(() => s.eventIds().length === 9, "every readable record");
  await s.live();
  expect(sorted(s.eventIds())).toEqual(sorted([after.id, ...meanwhile]));
  expect(s.attempts.has(live.id) || s.attempts.has(caught.id)).toBe(false);
  expect(s.stream.retries().map((row) => [row.record_id, row.terminal])).toEqual([
    [live.id, 1n],
    [caught.id, 1n],
  ]);
  expect(s.stream.retries()[0]?.last_error).toContain("cannot be read");
  // One line each: a record was handled between the two.
  expect(linesOf(s, FAILED_FOR_GOOD)).toEqual([
    expect.stringContaining(live.id),
    expect.stringContaining(caught.id),
  ]);
  expect(linesOf(s, REFUSED)).toEqual([]);
});

test("B155b: a queued record edited past the nesting limit is terminal at its retry, not refused", async () => {
  const name = unique("deepretry");
  const s = stream({ config: eventsOnly(), names: () => [name] });
  await s.live();
  const user = await pb.user();
  const id = recordId();
  s.fail.set(id, ["transient"]);
  await pb.event(user.id, name, {}, { id });
  await s.until(() => s.stream.retries().length === 1, "the queued record");
  // An events record's stamp is its `created`, which an edit keeps: the retry reads it again.
  await pb.update("events", id, { data: nested(70) });
  await s.retryAfter(60_000);
  expect(s.stream.retries()).toMatchObject([{ record_id: id, terminal: 1n }]);
  expect(linesOf(s, FAILED_FOR_GOOD)).toEqual([expect.stringContaining(id)]);
  expect(linesOf(s, REFUSED)).toEqual([]);
  expect(s.attempts.get(id)).toBe(1);
});

test("B155b: a readable record the ID-only read meets instead of the unreadable one is delivered, not terminal", async () => {
  const name = unique("race");
  const cut = proxy();
  const manual = config(cut.url, {
    events: { ...config().events, collection: "manual_events", key: "" },
    users: { collection: "", leavingFilter: "" },
  });
  // The seam: a readable record commits, stamped earlier than the unreadable one, between the
  // catch-up's failed read of the unreadable record alone and its read of that record's ID only.
  let racer: string | undefined;
  let commitRacer: (() => Promise<void>) | undefined;
  const s = stream({
    config: manual,
    names: () => [name],
    tuning: { pageSize: 5 },
    async beforeRequest(url) {
      if (commitRacer && url.searchParams.has("fields")) {
        const commit = commitRacer;
        commitRacer = undefined;
        await commit();
      }
    },
  });
  await s.live();
  const user = await pb.user();
  const create = async (offsetMs: number, data: unknown = {}) =>
    (
      await pb.create("manual_events", {
        user: user.id,
        name,
        data,
        occurredAt: stamp(0),
        created: stamp(offsetMs),
      })
    ).id;
  const anchor = await create(0);
  await s.until(() => s.eventIds().length === 1, "the anchor record");
  cut.cut();
  const deep = await create(2000, nested(70));
  const later = await create(3000);
  commitRacer = async () => {
    racer = await create(1000);
  };
  await s.until(() => s.eventIds().includes(later), "the record after the unreadable one");
  await s.live();
  expect(commitRacer).toBeUndefined();
  const raced = must(racer, "the racing record");
  expect(sorted(s.eventIds())).toEqual(sorted([anchor, raced, later]));
  expect(s.attempts.get(raced)).toBe(1);
  expect(s.attempts.has(deep)).toBe(false);
  expect(s.stream.retries().map((row) => [row.record_id, row.terminal])).toEqual([[deep, 1n]]);
  expect(linesOf(s, FAILED_FOR_GOOD)).toEqual([expect.stringContaining(deep)]);
  expect(linesOf(s, REFUSED)).toEqual([]);
});

test("B155b: an ID past the filter's 4,096-byte limit is terminal and never stalls the catch-up", async () => {
  // PocketBase 0.40.5 caps no ID length: it takes this 5,000-character ID.
  const events = await longIdEventsCollection(6000);
  const long = `long${"c".repeat(4996)}`;
  const cut = proxy();
  const name = unique("longid");
  // One record per page: every record, the long one too, is the bound of the next page.
  const s = stream({
    config: { ...events.settings, url: cut.url },
    names: () => [name],
    tuning: { pageSize: 1 },
  });
  await s.live();
  const user = await pb.user();
  const create = async (id?: string) =>
    (
      await pb.create(events.name, {
        ...(id ? { id } : {}),
        user: user.id,
        name,
        occurredAt: stamp(0),
        data: {},
      })
    ).id;
  const anchor = await create();
  await s.until(() => s.eventIds().length === 1, "the anchor record");
  cut.cut();
  const meanwhile = [await create()];
  expect(await create(long)).toBe(long);
  meanwhile.push(await create(), await create());
  await s.until(() => s.eventIds().length === 4, "every keyable record");
  await s.live();
  expect(sorted(s.eventIds())).toEqual(sorted([anchor, ...meanwhile]));
  // The store keeps an ID's first 255 characters.
  expect(s.stream.retries().map((row) => [row.record_id, row.terminal])).toEqual([
    [long.slice(0, 255), 1n],
  ]);
  expect(linesOf(s, FAILED_FOR_GOOD)).toEqual([expect.stringContaining(long.slice(0, 255))]);
  expect(linesOf(s, REFUSED)).toEqual([]);
});

test("B155b: a record whose ID the stream cannot key is terminal with one line, live and in a catch-up", async () => {
  const events = await longIdEventsCollection();
  const liveBad = `live${"a".repeat(100)}`;
  const caughtBad = `caught${"b".repeat(100)}`;
  const cut = proxy();
  const name = unique("badid");
  const s = stream({
    config: { ...events.settings, url: cut.url },
    names: () => [name],
    tuning: { pageSize: 5 },
  });
  await s.live();
  const user = await pb.user();
  const create = async (id?: string) =>
    (
      await pb.create(events.name, {
        ...(id ? { id } : {}),
        user: user.id,
        name,
        occurredAt: stamp(0),
        data: {},
      })
    ).id;
  await create(liveBad);
  const after = await create();
  await s.until(() => s.eventIds().includes(after), "the record after the unkeyable one");
  cut.cut();
  const meanwhile = [await create(), await create()];
  await create(caughtBad);
  meanwhile.push(await create(), await create());
  await s.until(() => s.eventIds().length === 5, "every keyable record");
  await s.live();
  expect(sorted(s.eventIds())).toEqual(sorted([after, ...meanwhile]));
  expect(s.stream.retries().map((row) => [row.record_id, row.terminal])).toEqual([
    [liveBad, 1n],
    [caughtBad, 1n],
  ]);
  expect(linesOf(s, FAILED_FOR_GOOD)).toEqual([
    expect.stringContaining(liveBad),
    expect.stringContaining(caughtBad),
  ]);
  expect(linesOf(s, REFUSED)).toEqual([]);
});

test("B155b: a record over the response limit is terminal with one line; the catch-up goes on", async () => {
  const name = unique("toolarge");
  // The live message is over its line limit, so a catch-up reads the record; its page is over the
  // response limit even alone.
  const s = stream({
    config: eventsOnly(),
    names: () => [name],
    tuning: { maxLine: 2000, pageSize: 5 },
    maxResponseBytes: 4000,
  });
  await s.live();
  const user = await pb.user();
  const big = await pb.event(user.id, name, { blob: "x".repeat(5000) });
  const after = await pb.event(user.id, name);
  await s.until(() => s.eventIds().includes(after.id), "the record after the large one");
  await s.live();
  expect(s.eventIds()).toEqual([after.id]);
  expect(s.stream.retries()).toMatchObject([{ record_id: big.id, terminal: 1n }]);
  expect(linesOf(s, FAILED_FOR_GOOD)).toEqual([
    expect.stringMatching(new RegExp(`${big.id}.*response limit`)),
  ]);
  expect(linesOf(s, REFUSED)).toEqual([]);
});

test("B159a: a record unreadable alone and then too large read by its ID names both causes, its own read by ID first", async () => {
  const name = unique("twocauses");
  const id = recordId();
  let edited = false;
  // The live message is over its line limit, so a catch-up reads the record; alone it nests past
  // the JSON limit. Before the confirming read by its ID it is edited past the response limit
  // (an events record keeps its `created` stamp), so the two reads fail for different causes.
  const s = stream({
    config: eventsOnly(),
    names: () => [name],
    tuning: { maxLine: 2000, pageSize: 5 },
    maxResponseBytes: 4000,
    async beforeRequest(url) {
      if (!edited && (url.searchParams.get("filter") ?? "").includes(`id = '${id}'`)) {
        edited = true;
        await pb.update("events", id, { data: { blob: "x".repeat(5000) } });
      }
    },
  });
  await s.live();
  const user = await pb.user();
  await pb.event(user.id, name, { pad: "p".repeat(2500), deep: nested(70) }, { id });
  const after = await pb.event(user.id, name);
  await s.until(() => s.eventIds().includes(after.id), "the record after the unreadable one");
  await s.live();
  expect(edited).toBe(true);
  expect(s.eventIds()).toEqual([after.id]);
  expect(s.stream.retries()).toMatchObject([{ record_id: id, terminal: 1n }]);
  expect(linesOf(s, FAILED_FOR_GOOD)).toEqual([
    expect.stringMatching(
      new RegExp(
        `${id}.*response limit \\(an earlier read at its position in the page: .*cannot be read: its JSON nests`,
      ),
    ),
  ]);
});

test("D186: an unreadable record the ID-only read meets instead of another leads with its own cause", async () => {
  const name = unique("othercause");
  const cut = proxy();
  const manual = config(cut.url, {
    events: { ...config().events, collection: "manual_events", key: "" },
    users: { collection: "", leavingFilter: "" },
  });
  // The size-1 read meets a record over the response limit; before the ID-only read, a record
  // nested past the JSON limit commits stamped earlier, so the ID-only read meets that one.
  let racer: string | undefined;
  let commitRacer: (() => Promise<void>) | undefined;
  const s = stream({
    config: manual,
    names: () => [name],
    tuning: { pageSize: 5 },
    maxResponseBytes: 4000,
    async beforeRequest(url) {
      if (commitRacer && url.searchParams.has("fields")) {
        const commit = commitRacer;
        commitRacer = undefined;
        await commit();
      }
    },
  });
  await s.live();
  const user = await pb.user();
  const create = async (offsetMs: number, data: unknown = {}) =>
    (
      await pb.create("manual_events", {
        user: user.id,
        name,
        data,
        occurredAt: stamp(0),
        created: stamp(offsetMs),
      })
    ).id;
  const anchor = await create(0);
  await s.until(() => s.eventIds().length === 1, "the anchor record");
  cut.cut();
  const big = await create(2000, { blob: "x".repeat(5000) });
  const later = await create(3000);
  commitRacer = async () => {
    racer = await create(1000, nested(70));
  };
  await s.until(() => s.eventIds().includes(later), "the record after the unreadable ones");
  await s.live();
  expect(commitRacer).toBeUndefined();
  const deep = must(racer, "the racing record");
  expect(sorted(s.eventIds())).toEqual(sorted([anchor, later]));
  expect(s.stream.retries().every((row) => row.terminal === 1n)).toBe(true);
  expect(sorted(s.stream.retries().map((row) => row.record_id))).toEqual(sorted([deep, big]));
  // The racer's line leads with its own cause; the big record's line names only its own.
  expect(linesOf(s, FAILED_FOR_GOOD)).toEqual([
    expect.stringMatching(
      new RegExp(
        `${deep}.*: The source record cannot be read: its JSON nests.*\\(an earlier read at its position in the page: .*response limit\\)`,
      ),
    ),
    expect.stringMatching(
      new RegExp(`${big}.*: The source record is larger than the response limit$`),
    ),
  ]);
  expect(linesOf(s, REFUSED)).toEqual([]);
});

test("B155b: a new source drops the old source's retry queue; the same source keeps it", async () => {
  const name = unique("moved");
  const first = stream({ config: eventsOnly(), names: () => [name] });
  await first.live();
  const user = await pb.user();
  const id = recordId();
  first.fail.set(id, ["transient"]);
  await pb.event(user.id, name, {}, { id });
  await first.until(() => first.stream.retries().length === 1, "the queued record");
  await first.stop();
  cleanups.pop();
  cleanups.push(() => rmSync(first.dir, { recursive: true, force: true }));
  const restart = () => ({ names: () => [name], dir: first.dir, clock: first.clock });
  // The same source after a restart: the row waits, and its retry delivers the record.
  const same = stream({ config: eventsOnly(), ...restart() });
  expect(same.stream.retries()).toMatchObject([{ record_id: id, terminal: 0n }]);
  await same.live();
  await same.stop();
  cleanups.pop();
  // The same records behind another URL (a copied database): a new source ignores history, so
  // the old source's row is never read against it.
  const cut = proxy();
  const moved = stream({ config: eventsOnly(cut.url), ...restart() });
  expect(moved.stream.retries()).toEqual([]);
  await moved.live();
  await moved.advance(RETRY_MAX_MS);
  moved.stream.wakeRetries();
  const other = await pb.event(user.id, name);
  await moved.until(() => moved.eventIds().includes(other.id), "a live record of the new source");
  expect(moved.attempts.has(id)).toBe(false);
});

test("B155b: a 2.1.0 retry row is kept for the same source and dropped for another", async () => {
  const name = unique("upgrade");
  const user = await pb.user();
  const first = stream({ config: eventsOnly(), names: () => [name] });
  await first.live();
  const queued = await pb.event(user.id, name, {}, { id: recordId() });
  await first.until(() => first.eventIds().includes(queued.id), "a record");
  await first.stop();
  cleanups.pop();
  cleanups.push(() => rmSync(first.dir, { recursive: true, force: true }));
  // A row as 2.1.0 wrote it (no source column), due now.
  const legacy = (id: string) => {
    const db = openDatabase(first.dir);
    try {
      db.query(
        `INSERT INTO source_stream_retries
           (kind, record_id, stamp, attempts, first_failed_at, next_attempt_at, last_error, terminal)
           VALUES ('event', ?, ?, 1, ?, ?, 'test', 0)`,
      ).run(
        id,
        String(queued.created),
        first.clock.now().toISOString(),
        first.clock.now().toISOString(),
      );
    } finally {
      db.close();
    }
  };
  const restart = () => ({ names: () => [name], dir: first.dir, clock: first.clock });
  legacy(queued.id);
  const same = stream({ config: eventsOnly(), ...restart() });
  expect(same.stream.retries()).toMatchObject([{ record_id: queued.id, terminal: 0n }]);
  await same.stop();
  cleanups.pop();
  legacy(recordId());
  const cut = proxy();
  const moved = stream({ config: eventsOnly(cut.url), ...restart() });
  expect(moved.stream.retries()).toEqual([]);
});

test("B155b: a refused retry of one kind writes one line though records of the other kind succeed", async () => {
  // A users collection of its own, so renaming its leaving field touches no other test.
  const people = unique("people");
  const rule = '@request.auth.collectionName = "services"';
  await pb.api("POST", "/api/collections", {
    name: people,
    type: "base",
    listRule: rule,
    viewRule: rule,
    fields: [
      { name: "deletedAt", type: "date" },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  });
  const name = unique("kinds");
  const s = stream({
    config: config(pb.url, { users: { collection: people, leavingFilter: "deletedAt != ''" } }),
    names: () => [name],
  });
  await s.live();
  const user = await pb.user();
  const leaving = recordId();
  const event = recordId();
  s.fail.set(leaving, ["transient"]);
  s.fail.set(event, ["transient"]);
  await pb.create(people, { id: leaving, deletedAt: stamp(0) });
  await pb.event(user.id, name, {}, { id: event });
  await s.until(() => s.stream.retries().length === 2, "both records queued");
  // The users side is misconfigured from now on: its re-read is refused.
  await pb.renameField(people, "deletedAt", "gone");
  const refused = () => linesOf(s, `${REFUSED}user ${leaving}:`);
  // Both rows are due: the user's re-read is refused (one line), then the event is handled.
  await s.advance(RETRY_MIN_MS);
  const done = s.rereads();
  s.stream.wakeRetries();
  await s.settle(() => s.rereads() >= done + 2, "both retries");
  await s.until(() => s.eventIds().includes(event), "the event's retry");
  expect(refused()).toHaveLength(1);
  // The user's next refusal is the same cause: no new line, although an event was handled.
  await s.retryAfter(2 * RETRY_MIN_MS);
  expect(s.stream.retries()).toMatchObject([{ record_id: leaving, terminal: 0n }]);
  expect(refused()).toHaveLength(1);
});

test("B155b: the retry queue: a re-read cut on the way stays transient", async () => {
  const name = unique("retrycut");
  const cut = proxy();
  const s = stream({ config: eventsOnly(cut.url), names: () => [name] });
  await s.live();
  const user = await pb.user();
  const id = recordId();
  s.fail.set(id, ["transient"]);
  await pb.event(user.id, name, {}, { id });
  await s.until(() => s.stream.retries().length === 1, "the queued record");
  const firstFailed = must(s.stream.retries()[0], "the row").first_failed_at;
  // The retry's re-read names the record's ID; the stream's own reads do not.
  cut.cutWhen((line) => line.includes(id));
  await s.retryAfter(RETRY_MIN_MS);
  expect(s.stream.retries()).toMatchObject([
    { record_id: id, terminal: 0n, waiting: 0n, first_failed_at: firstFailed },
  ]);
  expect(s.stream.retries()[0]?.last_error).toContain("unreachable");
  expectBackoff(s);
  expect(linesOf(s, REFUSED)).toEqual([]);
  expect(s.attempts.get(id)).toBe(1);
  // Reachable again: the next retry delivers it once.
  cut.cutWhen(undefined);
  await s.retryAfter(2 * RETRY_MIN_MS);
  expect(s.stream.retries()).toEqual([]);
  expect(s.eventIds()).toEqual([id]);
  expect(s.attention).toEqual([]);
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
