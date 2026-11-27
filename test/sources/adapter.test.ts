// B150a (15-external-sources sections 1 and 9, D170): every PocketBase adapter operation against the
// real 0.40.5 binary started by the harness. No protocol mock: the transport wrapper below only
// counts and records the requests the adapter makes.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createRealClock } from "@/clock";
import type { Clock } from "@/clock";
import { checkSource } from "@/sources/check";
import type { Guard } from "@/sources/connect";
import { createPocketBaseSource } from "@/sources/pocketbase";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import { isRecordUnreadable, isSourceError } from "@/sources/source";
import type { SourceError } from "@/sources/source";
import { TestClock } from "@/test/server/fixture";
import { sourceConfig, startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase } from "@/test/sources/pocketbase";

setDefaultTimeout(60_000);

let pb: PocketBase;
const open: Guard = { blockPrivate: () => false, privateHosts: () => [] };

/** An adapter on `pb` and the request paths it sent. */
function adapter(
  options: {
    clock?: Clock;
    guard?: Guard;
    config?: Partial<PocketBaseConfig>;
    maxResponseBytes?: number;
  } = {},
) {
  const requests: Array<string> = [];
  const source = createPocketBaseSource({
    config: { ...sourceConfig(pb.url, pb.service), ...options.config },
    clock: options.clock ?? createRealClock(),
    guard: options.guard ?? open,
    ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
    transport: {
      fetch: (input: URL, init: RequestInit) => {
        requests.push(`${init.method ?? "GET"} ${input.pathname}${input.search}`);
        return fetch(input, init);
      },
    },
  });
  const signIns = () => requests.filter((line) => line.includes("/auth-with-password")).length;
  return { source, requests, signIns };
}

async function failure(work: Promise<unknown>): Promise<SourceError> {
  try {
    await work;
  } catch (error) {
    if (isSourceError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a SourceError");
}

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  pb = await startPocketBase();
});

afterAll(async () => {
  await pb?.close();
});

test("recipient: the view's row, its opt-out field, and null for a user the view does not have", async () => {
  const { source } = adapter();
  const ada = await pb.user({ name: "Ada Lovelace" });
  const row = await source.recipient(ada.id);
  expect(row).toMatchObject({ id: ada.id, email: ada.email, name: "Ada Lovelace", optOut: false });
  expect(row?.fields.email).toBe(String(ada.email));
  await pb.update("users", ada.id, { marketingOptOut: true });
  expect((await source.recipient(ada.id))?.optOut).toBe(true);
  // Leaving: the view leaves out a user with deletedAt set.
  await pb.update("users", ada.id, { deletedAt: new Date().toISOString() });
  expect(await source.recipient(ada.id)).toBeNull();
  expect(await source.recipient("nosuchuser00000")).toBeNull();
  // An ID that is not a PocketBase ID never reaches a path.
  expect((await failure(source.recipient("../x"))).kind).toBe("permanent");
  expect((await failure(source.recipient(""))).kind).toBe("permanent");
});

test("record: one events record with the mapped fields, and null for an ID with no record", async () => {
  const { source } = adapter();
  const user = await pb.user();
  const made = await pb.event(
    user.id,
    "order_paid",
    { total: 12.5, items: [1, 2] },
    {
      occurredAt: "2026-03-04T05:06:07.890Z",
      key: `k-${crypto.randomUUID()}`,
    },
  );
  const record = await source.record(made.id);
  expect(record).toMatchObject({
    id: made.id,
    user: user.id,
    name: "order_paid",
    data: { total: 12.5, items: [1, 2] },
    key: String(made.key),
  });
  expect(record?.occurredAt.toISOString()).toBe("2026-03-04T05:06:07.890Z");
  expect(record?.created).toBeInstanceOf(Date);
  expect(await source.record("nosuchrecord000")).toBeNull();
});

test("latest, count and exists: the user, names, a strict window and data equality", async () => {
  const { source, requests } = adapter();
  const user = await pb.user();
  const other = await pb.user();
  const times = [
    "2026-05-01T00:00:00.000Z",
    "2026-05-02T00:00:00.000Z",
    "2026-05-03T00:00:00.000Z",
  ];
  for (const [index, time] of times.entries()) {
    await pb.event(
      user.id,
      "visit",
      { plan: index === 2 ? "pro" : "free", n: index },
      {
        occurredAt: time,
      },
    );
  }
  await pb.event(other.id, "visit", { plan: "pro" }, { occurredAt: "2026-06-01T00:00:00.000Z" });
  await pb.event(user.id, "signup", {}, { occurredAt: "2026-04-01T00:00:00.000Z" });

  const latest = await source.latest({ user: user.id, names: ["visit"] });
  expect(latest?.occurredAt.toISOString()).toBe(times[2]);
  expect((await source.latest({ user: user.id }))?.name).toBe("visit");
  expect(await source.latest({ user: user.id, names: ["nothing"] })).toBeNull();
  expect(await source.latest({ user: user.id, names: [] })).toBeNull();

  expect(await source.count({ user: user.id, names: ["visit"] }, 10)).toBe(3);
  expect(await source.count({ user: user.id, names: ["visit", "signup"] }, 10)).toBe(4);
  expect(await source.count({ user: user.id, names: ["visit"] }, 2)).toBe(2);
  // `after` is strict, `through` inclusive.
  expect(await source.count({ user: user.id, names: ["visit"], after: at(times[0]!) }, 10)).toBe(2);
  expect(
    await source.count(
      { user: user.id, names: ["visit"], after: at(times[0]!), through: at(times[1]!) },
      10,
    ),
  ).toBe(1);
  expect(await source.count({ user: user.id, data: { plan: "pro" } }, 10)).toBe(1);
  expect(await source.count({ user: user.id, data: { n: 1 } }, 10)).toBe(1);
  expect(await source.exists({ user: user.id, names: ["signup"] })).toBe(true);
  expect(await source.exists({ user: other.id, names: ["signup"] })).toBe(false);
  // Every list read skips the total, and exists reads one record.
  const lists = requests.filter((line) => line.includes("/records?"));
  expect(lists.length).toBeGreaterThan(0);
  expect(lists.every((line) => line.includes("skipTotal=1"))).toBe(true);
  expect(requests.some((line) => line.includes("perPage=1&"))).toBe(true);
});

test("scan: keyset pages of at most 1000 over (occurredAt, id), ties included, stopping at the limit", async () => {
  const { source, requests } = adapter();
  const user = await pb.user();
  const base = Date.parse("2026-07-01T00:00:00.000Z");
  const batch: Array<Promise<unknown>> = [];
  // 2,500 records, three on each instant, so pages break inside a tie.
  for (let index = 0; index < 2500; index++) {
    batch.push(
      pb.event(
        user.id,
        "tick",
        { i: index },
        {
          occurredAt: new Date(base + Math.floor(index / 3) * 1000).toISOString(),
        },
      ),
    );
    if (batch.length === 50) {
      await Promise.all(batch.splice(0));
    }
  }
  await Promise.all(batch);
  requests.length = 0;
  const seen: Array<string> = [];
  const sizes: Array<number> = [];
  let previous = "";
  for await (const page of source.scan({ user: user.id, names: ["tick"] }, ["data"], 5000)) {
    sizes.push(page.length);
    for (const row of page) {
      const keyOf = `${row.occurredAt.toISOString()}|${row.id}`;
      expect(keyOf > previous).toBe(true);
      previous = keyOf;
      seen.push(row.id);
      expect(row.data).toHaveProperty("i");
    }
  }
  expect(sizes).toEqual([1000, 1000, 500]);
  expect(new Set(seen).size).toBe(2500);
  const pages = requests.filter((line) => line.includes("/records?"));
  expect(pages.every((line) => Number(/perPage=(\d+)/.exec(line)![1]) <= 1000)).toBe(true);
  expect(pages.every((line) => line.includes("skipTotal=1"))).toBe(true);
  expect(pages.every((line) => line.includes("fields=id%2CoccurredAt%2Cdata"))).toBe(true);

  // A limit stops the read; a count stops at its bound.
  let total = 0;
  for await (const page of source.scan({ user: user.id }, [], 1500)) {
    total += page.length;
  }
  expect(total).toBe(1500);
  expect(await source.count({ user: user.id, names: ["tick"] }, 2400)).toBe(2400);
});

test("hostile literals read back exactly: quotes, backslashes, && and ||, unicode", async () => {
  const { source } = adapter();
  const user = await pb.user();
  const backslash = String.fromCodePoint(92);
  const hostile = [
    "it's",
    'say "hi"',
    `back${backslash}slash`,
    `trailing${backslash}`,
    `${backslash}'`,
    "x' || name != '",
    'x" || name != "',
    "a && b",
    "zażółć 😀",
    "",
  ];
  for (const name of hostile) {
    await pb.event(user.id, name || "empty-name", { s: name });
  }
  for (const name of hostile) {
    if (name) {
      expect(await source.count({ user: user.id, names: [name] }, 100)).toBe(1);
      expect((await source.latest({ user: user.id, names: [name] }))?.name).toBe(name);
    }
    expect(await source.count({ user: user.id, data: { s: name } }, 100)).toBe(1);
  }
  // A hostile user ID or data path is refused before any request.
  expect((await failure(source.count({ user: "a' || user != '" }, 10))).kind).toBe("permanent");
  expect((await failure(source.count({ data: { "a') || (1": 1 } }, 10))).kind).toBe("permanent");
  expect((await failure(source.count({ data: { n: Number.POSITIVE_INFINITY } }, 10))).kind).toBe(
    "permanent",
  );
});

test("the token is renewed half way to its expiry on the injected clock", async () => {
  const clock = new TestClock();
  const { source, signIns } = adapter({ clock });
  const user = await pb.user();
  await source.recipient(user.id);
  expect(signIns()).toBe(1);
  // The services collection keeps PocketBase's default token duration of 7 days.
  clock.advance(2 * 86_400_000);
  await source.recipient(user.id);
  expect(signIns()).toBe(1);
  clock.advance(2 * 86_400_000);
  await source.recipient(user.id);
  expect(signIns()).toBe(2);
});

test("a revoked token is noticed although PocketBase reads it as a guest: one sign-in, then the right answer", async () => {
  const { source, signIns, requests } = adapter();
  const user = await pb.user();
  await pb.event(user.id, "revoked", {});
  expect(await source.count({ user: user.id }, 10)).toBe(1);
  expect(signIns()).toBe(1);
  // A password change gives the account a new token key: every token issued before is invalid.
  // Changing it back keeps the configured password working.
  const [account] = (await pb.api("GET", "/api/collections/services/records")).items;
  for (const password of ["temporary-password-9", pb.service.password]) {
    await pb.update("services", account.id, { password, passwordConfirm: password });
  }
  // As a guest the read is a 404 and an empty list; the adapter checks its token (401) and reads again.
  expect((await source.recipient(user.id))?.id).toBe(user.id);
  expect(signIns()).toBe(2);
  expect(requests.some((line) => line.includes("/auth-refresh"))).toBe(true);
  await pb.update("services", account.id, {
    password: "temporary-password-9",
    passwordConfirm: "temporary-password-9",
  });
  await pb.update("services", account.id, {
    password: pb.service.password,
    passwordConfirm: pb.service.password,
  });
  expect(await source.count({ user: user.id }, 10)).toBe(1);
  expect(await source.exists({ user: user.id })).toBe(true);
  expect(signIns()).toBe(3);
});

/** Invalidates every token issued so far: a password round-trip gives the account a new token key. */
async function revokeTokens() {
  const [account] = (await pb.api("GET", "/api/collections/services/records")).items;
  for (const password of ["temporary-password-9", pb.service.password]) {
    await pb.update("services", account.id, { password, passwordConfirm: password });
  }
}

/**
 * An adapter whose transport (the test seam) can hold one response: `hold(pattern)` holds the
 * response of the next request whose path matches until `release()`, and resolves once that
 * request has been answered.
 */
function holding() {
  let armed: RegExp | undefined;
  const gate = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  let signIns = 0;
  const source = createPocketBaseSource({
    config: sourceConfig(pb.url, pb.service),
    clock: createRealClock(),
    guard: open,
    transport: {
      fetch: async (input: URL, init: RequestInit) => {
        if (input.pathname.endsWith("/auth-with-password")) {
          signIns++;
        }
        const held = armed?.test(`${input.pathname}${input.search}`) ?? false;
        if (held) {
          armed = undefined;
        }
        const response = await fetch(input, init);
        if (held) {
          answered.resolve();
          await gate.promise;
        }
        return response;
      },
    },
  });
  return {
    source,
    signIns: () => signIns,
    hold(pattern: RegExp) {
      armed = pattern;
      return answered.promise;
    },
    release: () => gate.resolve(),
  };
}

type Source = ReturnType<typeof createPocketBaseSource>;
interface Raced {
  user: string;
  event: string;
}
/** The operation, the read it holds, and its true answer ("user" and "event" name the IDs). */
const races: Array<[string, RegExp, (source: Source, raced: Raced) => Promise<unknown>, unknown]> =
  [
    ["count", /\/events\/records\?/, (source, { user }) => source.count({ user }, 10), 1],
    ["exists", /\/events\/records\?/, (source, { user }) => source.exists({ user }), true],
    [
      "scan (a short page)",
      /\/events\/records\?/,
      async (source, { user }) => {
        const ids: Array<string> = [];
        for await (const page of source.scan({ user }, [], 10)) {
          ids.push(...page.map((row) => row.id));
        }
        return ids.length;
      },
      1,
    ],
    [
      "latest",
      /\/events\/records\?/,
      async (source, { user }) => (await source.latest({ user }))?.name,
      "raced",
    ],
    [
      "record",
      /\/events\/records\/[^?]+$/,
      async (source, { event }) => (await source.record(event))?.id,
      "event",
    ],
    [
      "recipient",
      /\/recipients\/records\/[^?]+$/,
      async (source, { user }) => (await source.recipient(user))?.id,
      "user",
    ],
  ];

test.each(races)(
  "%s: an empty or 404 answer read with a revoked token is not trusted after another caller signs in again",
  async (_name, pattern, operation, expected) => {
    const user = await pb.user();
    const event = await pb.event(user.id, "raced", {});
    const { source, signIns, hold, release } = holding();
    expect(await source.count({ user: user.id }, 10)).toBe(1);
    await revokeTokens();
    // Caller A reads with the revoked token and, as a guest, gets an empty list or a 404; its
    // answer is held while caller B notices the revoked token and signs in again.
    const answered = hold(pattern);
    const held = operation(source, { user: user.id, event: event.id });
    await answered;
    const other = await pb.user();
    expect((await source.recipient(other.id))?.id).toBe(other.id);
    expect(signIns()).toBe(2);
    release();
    const want = expected === "user" ? user.id : expected === "event" ? event.id : expected;
    expect(await held).toBe(want);
  },
);

/**
 * An adapter whose transport (the test seam) can hold responses: `hold(pattern)` holds the
 * response of the next request whose path matches; `answered` settles once that request has been
 * answered by the binary, and `release()` hands the answer on. Several holds may be armed.
 */
function gated() {
  const armed: Array<{ pattern: RegExp; answered: () => void; gate: Promise<void> }> = [];
  const requests: Array<string> = [];
  const source = createPocketBaseSource({
    config: sourceConfig(pb.url, pb.service),
    clock: createRealClock(),
    guard: open,
    transport: {
      fetch: async (input: URL, init: RequestInit) => {
        const path = `${input.pathname}${input.search}`;
        requests.push(`${init.method ?? "GET"} ${path}`);
        const index = armed.findIndex(({ pattern }) => pattern.test(path));
        const held = index >= 0 ? armed.splice(index, 1)[0] : undefined;
        const response = await fetch(input, init);
        if (held) {
          held.answered();
          await held.gate;
        }
        return response;
      },
    },
  });
  return {
    source,
    requests,
    hold(pattern: RegExp) {
      const answered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      armed.push({ pattern, answered: answered.resolve, gate: gate.promise });
      return { answered: answered.promise, release: () => gate.resolve() };
    },
  };
}

/** The settled value or the rejection of `work`, to compare either. */
const outcomeOf = (work: Promise<unknown>) =>
  work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

test("B163: one caller's abort or timeout during a shared sign-in rejects only that caller", async () => {
  const user = await pb.user();
  for (const how of ["abort", "timeout"] as const) {
    const { source, requests, hold } = gated();
    // Caller A starts the sign-in; its answer is held while caller B joins it and A gives up.
    const signIn = hold(/\/auth-with-password$/);
    const controller = new AbortController();
    const stopped = new Error("caller A stopped");
    const a = outcomeOf(
      source.recipient(
        user.id,
        how === "abort" ? { signal: controller.signal } : { timeoutMs: 200 },
      ),
    );
    await signIn.answered;
    const b = source.recipient(user.id);
    if (how === "abort") {
      controller.abort(stopped);
    }
    const first = await a;
    signIn.release();
    // B gets the right answer from the one sign-in; A gets only its own failure.
    expect((await b)?.id).toBe(user.id);
    expect(requests.filter((line) => line.includes("/auth-with-password"))).toHaveLength(1);
    if (how === "abort") {
      expect(first).toEqual({ error: stopped });
    } else {
      expect("error" in first && isSourceError(first.error) && first.error.kind).toBe("transient");
    }
  }
});

test("B163 r1: a token check sent before another caller's guest read is not shared with it: a live user is read again, never null", async () => {
  const { source, requests, hold } = gated();
  const empty = await pb.user();
  const live = await pb.user();
  expect(await source.latest({ user: empty.id })).toBeNull();
  // Caller A's empty read is confirmed; its check reaches PocketBase before the revocation and its
  // answer (200) is held.
  const check = hold(/\/auth-refresh$/);
  const a = outcomeOf(source.latest({ user: empty.id }));
  await check.answered;
  await revokeTokens();
  // Caller B reads a live user with the now revoked token: as a guest it gets a 404, after A's
  // check was sent, so A's 200 proves nothing about B's read.
  const read = hold(/\/recipients\/records\/[^?]+$/);
  const b = outcomeOf(source.recipient(live.id));
  await read.answered;
  read.release();
  await Bun.sleep(100);
  check.release();
  expect(await b).toEqual({ value: expect.objectContaining({ id: live.id }) });
  expect(await a).toEqual({ value: null });
  // B checked its own token (401) and signed in again.
  expect(requests.filter((line) => line.includes("/auth-refresh")).length).toBeGreaterThanOrEqual(
    3,
  );
  expect(requests.filter((line) => line.includes("/auth-with-password"))).toHaveLength(2);
});

test("B163 r1: an already aborted caller sends no sign-in, leaves no unhandled rejection and keeps the token", async () => {
  const unhandled: Array<unknown> = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const wrong = adapter({ config: { password: "not-the-password" } });
    const controller = new AbortController();
    const stopped = new Error("caller stopped");
    controller.abort(stopped);
    expect(
      await outcomeOf(wrong.source.recipient("nosuchuser00000", { signal: controller.signal })),
    ).toEqual({ error: stopped });
    expect(await outcomeOf(wrong.source.authenticate({ signal: controller.signal }))).toEqual({
      error: stopped,
    });
    // A sign-in that had been sent would have been refused by now.
    await Bun.sleep(300);
    expect(wrong.requests).toEqual([]);
    expect(unhandled).toEqual([]);
    // An aborted settings check does not drop the token the adapter holds.
    const { source, signIns } = adapter();
    const user = await pb.user();
    expect((await source.recipient(user.id))?.id).toBe(user.id);
    expect(await outcomeOf(source.authenticate({ signal: controller.signal }))).toEqual({
      error: stopped,
    });
    expect((await source.recipient(user.id))?.id).toBe(user.id);
    expect(signIns()).toBe(1);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("B163: concurrent empty reads across token renewals are confirmed by the token each used", async () => {
  const { source, requests, hold } = gated();
  const empty = await pb.user();
  const reads = /\/events\/records\?/;
  expect(await source.latest({ user: empty.id })).toBeNull();
  // Caller A's empty read is held; meanwhile, a second later (PocketBase's expiry has whole
  // seconds), caller B's empty read is confirmed and renews the held token.
  const first = hold(reads);
  const a = outcomeOf(source.latest({ user: empty.id }));
  await first.answered;
  await Bun.sleep(1100);
  expect(await source.latest({ user: empty.id })).toBeNull();
  // Should A read again, its second read is held too, across another renewal by caller C.
  const again = hold(reads);
  first.release();
  const settled = await Promise.race([a.then(() => "settled"), again.answered.then(() => "read")]);
  if (settled === "read") {
    await Bun.sleep(1100);
    expect(await source.latest({ user: empty.id })).toBeNull();
  }
  again.release();
  expect(await a).toEqual({ value: null });
  // The renewals happened: the checks gave new tokens, and none was a sign-in.
  expect(requests.filter((line) => line.includes("/auth-with-password"))).toHaveLength(1);
});

test("a wrong password is a permanent failure", async () => {
  const { source } = adapter({ config: { password: "not-the-password" } });
  const error = await failure(source.recipient("nosuchuser00000"));
  expect(error.kind).toBe("permanent");
  expect(error.status).toBe(400);
});

test("a missing collection is permanent, never an absent record", async () => {
  const { source } = adapter({
    config: {
      recipients: { collection: "nobody", email: "email", name: "name", optOut: "" },
    },
  });
  expect((await failure(source.recipient("nosuchuser00000"))).kind).toBe("permanent");
});

test("a response over the size limit is permanent for one record; a scan reads smaller pages", async () => {
  const user = await pb.user();
  for (let index = 0; index < 20; index++) {
    await pb.event(user.id, "large", { text: "x".repeat(500) });
  }
  const { source, requests } = adapter({ maxResponseBytes: 4000 });
  let total = 0;
  for await (const page of source.scan({ user: user.id }, ["data"], 100)) {
    total += page.length;
  }
  expect(total).toBe(20);
  expect(requests.some((line) => /perPage=(?:[1-9]|1\d|2\d)&/.test(line))).toBe(true);
  const tiny = adapter({ maxResponseBytes: 300 });
  const [first] = (
    await pb.api(
      "GET",
      `/api/collections/events/records?filter=${encodeURIComponent(`user = '${user.id}'`)}&perPage=1`,
    )
  ).items;
  expect((await failure(tiny.source.record(first.id))).kind).toBe("permanent");
});

test("B166: exists over a single matching record too large to read sends one request, then the permanent too-large error", async () => {
  const user = await pb.user();
  await pb.event(user.id, "oversized");
  // `exists` reads only `id` and `occurredAt`, so no real record of the fixture schema is over a
  // limit the sign-in still fits under: the binary's events list answer is padded with JSON
  // whitespace past it, and is otherwise unchanged.
  const reads: Array<string> = [];
  const source = createPocketBaseSource({
    config: sourceConfig(pb.url, pb.service),
    clock: createRealClock(),
    guard: open,
    maxResponseBytes: 4000,
    transport: {
      fetch: async (input: URL, init: RequestInit) => {
        const answer = await fetch(input, init);
        if (input.pathname !== "/api/collections/events/records") {
          return answer;
        }
        reads.push(input.search);
        return new Response(`${await answer.text()}${" ".repeat(5000)}`, answer);
      },
    },
  });
  const refused = await failure(source.exists({ user: user.id, names: ["oversized"] }));
  expect(refused.kind).toBe("permanent");
  expect(refused.message).toContain("larger than the response limit");
  expect(reads.length).toBe(1);
  expect(new URLSearchParams(reads[0]).get("perPage")).toBe("1");
});

test("the private-address block: refused unless the host is listed; a listed name still resolves to a checked address", async () => {
  const user = await pb.user();
  const blocked: Guard = { blockPrivate: () => true, privateHosts: () => [] };
  const refused = await failure(adapter({ guard: blocked }).source.recipient(user.id));
  expect(refused.kind).toBe("permanent");
  expect(refused.message).toContain("block_private_addresses");
  const named = `http://localhost:${pb.port}`;
  const other: Guard = { blockPrivate: () => true, privateHosts: () => ["pocketbase"] };
  expect(
    (await failure(adapter({ guard: other, config: { url: named } }).source.recipient(user.id)))
      .message,
  ).toContain("block_private_addresses");
  const listed: Guard = { blockPrivate: () => true, privateHosts: () => ["localhost"] };
  expect(
    (await adapter({ guard: listed, config: { url: named } }).source.recipient(user.id))?.id,
  ).toBe(user.id);
  // An address literal is never listed, even when its text is on the list.
  const literal: Guard = { blockPrivate: () => true, privateHosts: () => ["127.0.0.1"] };
  expect((await failure(adapter({ guard: literal }).source.recipient(user.id))).kind).toBe(
    "permanent",
  );
});

test("a paused server times out as transient; a caller's abort rejects with its reason", async () => {
  const { source } = adapter();
  const user = await pb.user();
  await source.recipient(user.id);
  // Settles once every PocketBase thread is stopped, so no answer can come (B154).
  await pb.pause();
  try {
    const slow = await failure(source.recipient(user.id, { timeoutMs: 300 }));
    expect(slow.kind).toBe("transient");
    expect(slow.message).toBe("The source did not answer in time");
    const controller = new AbortController();
    const pending = source.recipient(user.id, { signal: controller.signal });
    const stoppedByCaller = new Error("caller stopped");
    controller.abort(stoppedByCaller);
    // The reason itself, not a SourceError that only quotes it.
    expect(
      await pending.then(
        () => "answered",
        (error: unknown) => error,
      ),
    ).toBe(stoppedByCaller);
  } finally {
    pb.resume();
  }
});

test("a renamed field is permanent; a stopped server is transient", async () => {
  const local = await startPocketBase();
  try {
    const config = sourceConfig(local.url, local.service);
    const source = createPocketBaseSource({ config, clock: createRealClock(), guard: open });
    const user = await local.user();
    const made = await local.event(user.id, "renamed", {});
    expect(await source.count({ user: user.id }, 10)).toBe(1);
    await local.renameField("events", "occurredAt", "happenedAt");
    const renamed = await failure(source.count({ user: user.id }, 10));
    expect(renamed.kind).toBe("permanent");
    expect(renamed.status).toBe(400);
    expect((await failure(source.record(made.id))).kind).toBe("permanent");
    await local.stop();
    const stopped = await failure(source.recipient(user.id));
    expect(stopped.kind).toBe("transient");
  } finally {
    await local.close();
  }
});

// B155f item 4 (D181): sources.private_hosts takes host names only, so a refused address literal
// is told to use a host name, while a refused name is told it can be listed.
test("Test connection: a refused address literal says to use a host name, a refused name says to list it", async () => {
  const blocked: Guard = { blockPrivate: () => true, privateHosts: () => [] };
  const literal = await checkSource(
    sourceConfig(`http://127.0.0.1:${pb.port}`, pb.service),
    createRealClock(),
    blocked,
  );
  expect(literal.ok).toBe(false);
  expect(literal.steps[0]?.message).toContain("block_private_addresses");
  expect(literal.steps[0]?.message).toContain("use a host name");
  expect(literal.steps[0]?.message).not.toContain("can list it in sources.private_hosts");
  const ipv6 = await checkSource(
    sourceConfig(`http://[::1]:${pb.port}`, pb.service),
    createRealClock(),
    blocked,
  );
  expect(ipv6.steps[0]?.message).toContain("use a host name");
  const named = await checkSource(
    sourceConfig(`http://localhost:${pb.port}`, pb.service),
    createRealClock(),
    blocked,
  );
  expect(named.steps[0]?.message).toContain("can list it in sources.private_hosts");
  expect(named.steps[0]?.message).not.toContain("use a host name");
});

// B155f item 5 (D181): a readable but empty collection is not reported as a hidden one.
test("Test connection: an empty collection reads as 'no records yet, or the list rule hides them'", async () => {
  const rule = '@request.auth.collectionName = "services"';
  await pb.api("POST", "/api/collections", {
    name: "nobody_yet",
    type: "view",
    listRule: rule,
    viewRule: rule,
    viewQuery: "SELECT u.id, u.email, u.name, u.marketingOptOut AS optOut FROM users u WHERE 1 = 0",
  });
  const config = sourceConfig(pb.url, pb.service);
  const report = await checkSource(
    { ...config, recipients: { ...config.recipients, collection: "nobody_yet" } },
    createRealClock(),
    open,
  );
  const recipients = report.steps.find((step) => step.step === "recipients");
  expect(recipients?.ok).toBe(true);
  expect(recipients?.message).toBe(
    "nobody_yet: read, but there are no records yet, or the list rule hides them from the service account.",
  );
});

test("B166: a large error page (a proxy's 502 or 403) on an events read is that status's failure, not a record too large to read", async () => {
  const user = await pb.user();
  await pb.event(user.id, "proxied");
  // A 403 signs in again and repeats the read once; neither is narrowed to smaller pages.
  for (const [status, kind, sent] of [
    [502, "transient", 1],
    [403, "permanent", 2],
  ] as const) {
    const reads: Array<string> = [];
    const source = createPocketBaseSource({
      config: sourceConfig(pb.url, pb.service),
      clock: createRealClock(),
      guard: open,
      maxResponseBytes: 4000,
      transport: {
        fetch: async (input: URL, init: RequestInit) => {
          if (input.pathname !== "/api/collections/events/records") {
            return fetch(input, init);
          }
          reads.push(input.search);
          return new Response(`<!doctype html><title>Bad gateway</title>${" ".repeat(5000)}`, {
            status,
            headers: { "content-type": "text/html" },
          });
        },
      },
    });
    const refused = await failure(source.exists({ user: user.id, names: ["proxied"] }));
    expect({
      kind: refused.kind,
      status: refused.status,
      unreadable: isRecordUnreadable(refused),
    }).toEqual({
      kind,
      status,
      unreadable: false,
    });
    expect(refused.message).not.toContain("larger than the response limit");
    expect(reads.length).toBe(sent);
  }
});

test("B166 round 4: a large 502 page on a record or recipient by ID, or on the events schema probe, is a transient 502, not a page too large to read", async () => {
  const user = await pb.user();
  const event = await pb.event(user.id, "proxied_one");
  const source = createPocketBaseSource({
    config: sourceConfig(pb.url, pb.service),
    clock: createRealClock(),
    guard: open,
    maxResponseBytes: 4000,
    transport: {
      fetch: async (input: URL, init: RequestInit) => {
        if (!input.pathname.startsWith("/api/collections/") || input.pathname.includes("/auth-")) {
          return fetch(input, init);
        }
        return new Response(`<!doctype html><title>Bad gateway</title>${" ".repeat(5000)}`, {
          status: 502,
          headers: { "content-type": "text/html" },
        });
      },
    },
  });
  for (const work of [source.record(event.id), source.recipient(user.id), source.eventsSchema()]) {
    const refused = await failure(work);
    expect({
      kind: refused.kind,
      status: refused.status,
      tooLarge: refused.message.includes("larger than the response limit"),
    }).toEqual({ kind: "transient", status: 502, tooLarge: false });
  }
});

// B169 (D197): Test connection's probes read only IDs and need a PocketBase list on a 200.
const serviceRule = '@request.auth.collectionName = "services"';
const stepsOf = (report: Awaited<ReturnType<typeof checkSource>>) =>
  Object.fromEntries(report.steps.map((step) => [step.step, step]));

test("B169: Test connection fails a 200 that is no PocketBase list (a proxy's {}), for the service account's probes and a guest's", async () => {
  for (const who of ["service", "guest"] as const) {
    const report = await checkSource(sourceConfig(pb.url, pb.service), createRealClock(), open, {
      fetch: (input: URL, init: RequestInit) => {
        const guest = !new Headers(init.headers).get("authorization");
        if (
          /^\/api\/collections\/[^/]+\/records$/.test(input.pathname) &&
          (who === "service" || guest)
        ) {
          return Promise.resolve(Response.json({}));
        }
        return fetch(input, init);
      },
    });
    const steps = stepsOf(report);
    expect(report.ok).toBe(false);
    expect(steps.auth?.ok).toBe(true);
    for (const collection of ["recipients", "events"] as const) {
      expect({ who, ...steps[collection] }).toMatchObject({
        who,
        ok: false,
        message: `The source's ${collection} list has no items`,
      });
    }
    if (who === "service") {
      expect(steps.users).toMatchObject({
        ok: false,
        message: "The source's users list has no items",
      });
    }
  }
  // Answered by PocketBase itself, every step passes.
  expect((await checkSource(sourceConfig(pb.url, pb.service), createRealClock(), open)).ok).toBe(
    true,
  );
});

test("B169: Test connection passes a valid events collection whose first record is nested past 64 levels", async () => {
  await pb.api("POST", "/api/collections", {
    name: "deep_events",
    type: "base",
    listRule: serviceRule,
    viewRule: serviceRule,
    fields: [
      { name: "user", type: "relation", collectionId: "_pb_users_auth_", maxSelect: 1 },
      { name: "name", type: "text" },
      { name: "data", type: "json" },
      { name: "occurredAt", type: "date" },
      { name: "key", type: "text" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  });
  let data: unknown = "deep";
  for (let level = 0; level < 70; level++) {
    data = { a: data };
  }
  const user = await pb.user();
  await pb.create("deep_events", {
    user: user.id,
    name: "deep",
    data,
    occurredAt: new Date().toISOString(),
  });
  const config = sourceConfig(pb.url, pb.service);
  const report = await checkSource(
    { ...config, events: { ...config.events, collection: "deep_events" } },
    createRealClock(),
    open,
  );
  expect(stepsOf(report).events).toMatchObject({ ok: true, message: "deep_events: read." });
  expect(report.ok).toBe(true);
});

test("B169: Test connection fails a users collection without `updated`, naming the field", async () => {
  await pb.api("POST", "/api/collections", {
    name: "people_no_updated",
    type: "base",
    listRule: serviceRule,
    viewRule: serviceRule,
    fields: [
      { name: "deletedAt", type: "date" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
  });
  const config = sourceConfig(pb.url, pb.service);
  const report = await checkSource(
    { ...config, users: { collection: "people_no_updated", leavingFilter: "deletedAt != ''" } },
    createRealClock(),
    open,
  );
  expect(report.ok).toBe(false);
  expect(stepsOf(report).users).toEqual({
    step: "users",
    ok: false,
    message: "people_no_updated has no field updated.",
    missing: ["updated"],
  });
});
