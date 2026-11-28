// B162c (15-external-sources "Adding a connector", D187, D190): the connector contract suite. Every
// connector passes it against its own release binary: `connectorContract` registers the tests for
// one connector name and harness, and each `connector-contract-<name>.test.ts` calls it once. It
// reaches the connector only as production does, through `connectors[name]`, and asserts results,
// never request counts, since binaries differ in how many requests a result takes (D189: iglo.base
// answers a revoked token `401` where PocketBase 0.40.5 reads it as a guest). Where a binary's
// behavior differs and the connector handles it (D189), the target names the value per binary and
// the test checks the difference was met, so a test cannot pass without exercising it.
//
// Covered: settings validation and Test connection (with the guest-readable check and the
// private-address rule with `sources.private_hosts`) through the compiled executable; every adapter
// operation, hostile filter literals, token renewal and a revoked token, transient and permanent
// errors, the private-address guard; the realtime stream (live delivery, a cut connection and a
// reader fallen behind caught up with nothing lost or doubled, a reset routine, a revoked token on
// the subscription); the record handler (subscriber upsert, grants and their refusals, leaving);
// and the send-time lookup. The protocol is the binary's: the only transport hooks record requests
// and answers, and the proxies forward bytes unchanged.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createRealClock } from "@/clock";
import type { Clock } from "@/clock";
import type { Guard } from "@/sources/connect";
import { connectors } from "@/sources/connectors";
import type { ConnectorName } from "@/sources/connectors";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import type { RecordOutcome } from "@/sources/records";
import { createSourceRecords } from "@/sources/records-stream";
import type { SourceRecords } from "@/sources/records-stream";
import type { GrantRule } from "@/sources/settings";
import { isAuthRefused, isSourceError } from "@/sources/source";
import type { SourceError } from "@/sources/source";
import { TOPIC_CHECK_MS } from "@/sources/stream";
import { enableBatch } from "@/test/conditions/source-fixture";
import type { JsonObject } from "@/test/json-object";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import type { InstanceSession } from "@/test/projects/admin-fixture";
import {
  adminCredentials,
  api,
  createApiUser,
  logIn,
  prepareExecutable,
  registerProjects,
  startInstance,
} from "@/test/projects/fixture";
import { asBody, readJson } from "@/test/read-body";
import { day, schedulerFixture } from "@/test/scheduler/fixture";
import type { SchedulerFixture } from "@/test/scheduler/fixture";
import { TestClock } from "@/test/server/fixture";
import { startStallProxy } from "@/test/sources/connector-contract-proxy";
import { sourceConfig } from "@/test/sources/pocketbase";
import type { PocketBase, PocketBaseRecord } from "@/test/sources/pocketbase";
import { openGuard, startStream } from "@/test/sources/stream-fixture";
import type { StreamFixture } from "@/test/sources/stream-fixture";
import { startCutProxy } from "@/test/sources/stream-proxy";

/** One connector and its binary, with what the binary does differently (D189), per binary. */
export interface ContractTarget {
  connector: ConnectorName;
  /** What the settings page and the messages call it, and the URL example they give. */
  displayName: string;
  exampleUrl: string;
  start(): Promise<PocketBase>;
  /**
   * How the binary answers a list, a view or a realtime subscription sent with a revoked token:
   * as a guest's (PocketBase 0.40.5: an empty list, a 404, a 204) or `401` (iglo.base, D189).
   */
  revokedToken: "guest" | 401;
  /** Whether the binary closes a realtime connection once 8 MiB are unsent (iglo.base, D189). */
  closesWhenBehind: boolean;
}

const HOST = "127.0.0.1";
const SERVICE_RULE = '@request.auth.collectionName = "services"';

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

const unique = (label: string) => `${label}_${crypto.randomUUID().slice(0, 8)}`;
const sorted = (ids: Iterable<string>) => [...ids].sort();
const emailOf = (user: PocketBaseRecord) => asBody<string>(user.email);

/** Invalidates every token issued so far: a password round-trip gives the account a new token key. */
async function revokeTokens(base: PocketBase) {
  const [account] = (await base.api("GET", "/api/collections/services/records")).items;
  for (const password of ["temporary-password-9", base.service.password]) {
    await base.update("services", account.id, { password, passwordConfirm: password });
  }
}

const stepsOf = (answer: { body: { data: { steps: unknown } } }) =>
  Object.fromEntries(
    asBody<Array<{ step: string; ok: boolean; message: string; missing: Array<string> }>>(
      answer.body.data.steps,
    ).map((step) => [step.step, step]),
  );
const tx = (template: number) => ({ wait: "P1D", kind: "transactional", template_id: template });

export function connectorContract(target: ContractTarget) {
  const { connector, displayName, exampleUrl } = target;
  let base: PocketBase;
  const sourceAt = (url: string) => ({
    "source.connector": connector,
    "source.url": url,
    "source.identity": base.service.identity,
    "source.password": base.service.password,
    "source.users": { collection: "users", leaving_filter: "deletedAt != ''" },
  });
  const eventsOnly = (url = base.url): PocketBaseConfig => ({
    ...sourceConfig(url, base.service),
    users: { collection: "", leavingFilter: "" },
  });

  beforeAll(async () => {
    base = await target.start();
  });
  afterAll(async () => {
    await base?.close();
  });

  /** The connector's source on `base` and every request it sent with its answer's status. */
  function adapter(
    options: { clock?: Clock; guard?: Guard; config?: Partial<PocketBaseConfig> } = {},
  ) {
    const answers: Array<string> = [];
    const source = connectors[connector].create({
      config: { ...sourceConfig(base.url, base.service), ...options.config },
      clock: options.clock ?? createRealClock(),
      guard: options.guard ?? openGuard,
      transport: {
        fetch: async (input: URL, init: RequestInit) => {
          const answer = await fetch(input, init);
          answers.push(`${init.method ?? "GET"} ${input.pathname} ${answer.status}`);
          return answer;
        },
      },
    });
    const signIns = () => answers.filter((line) => line.includes("/auth-with-password")).length;
    return { source, answers, signIns };
  }

  // -------------------------------------------------------------------------------------------
  describe(`${connector}: settings and Test connection through the compiled executable`, () => {
    let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
    let server: Awaited<ReturnType<typeof startInstance>> | undefined;
    let port = 0;
    let key = "";
    let operator: InstanceSession;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await api(port, HOST, key, method, path, body);
      return { status: response.status, body: response.text ? JSON.parse(response.text) : {} };
    };
    const instance = async (method: string, path: string, body?: unknown) => {
      const response = await instanceCall(port, HOST, operator, method, path, body);
      return { status: response.status, body: await readJson<any>(response) };
    };
    const setInstance = async (changes: Record<string, unknown>) => {
      const shared = (await instance("GET", "/api/instance/settings")).body.data;
      const saved = await instance("PUT", "/api/instance/settings", { ...shared, ...changes });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    };
    const settings = async () =>
      asBody<Record<string, unknown>>((await call("GET", "/api/settings")).body.data);
    const save = async (changes: Record<string, unknown>) =>
      call("PUT", "/api/settings", { ...(await settings()), ...changes });

    beforeAll(async () => {
      const admin = await adminCredentials();
      prepared = await prepareExecutable();
      const dataDir = `${prepared.directory}/data`;
      registerProjects(dataDir, [{ slug: "main", name: "Main", hostname: HOST, primary: true }]);
      server = await startInstance(prepared.executable, dataDir, admin);
      port = server.port;
      key = await createApiUser(port, HOST, await logIn(port, HOST, admin), "api-contract");
      operator = (await instanceLogin(port, HOST, admin)).session!;
      await setInstance({ "sources.enabled": true, "sources.private_hosts": ["localhost"] });
    });
    afterAll(async () => {
      await server?.stop();
      await prepared?.cleanup();
    });

    test("a source on this connector saves; the validation messages name the connector", async () => {
      const url = `http://localhost:${base.port}`;
      const saved = await save(sourceAt(url));
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const project = await settings();
      expect(project["source.connector"]).toBe(connector);
      expect(project["source.url"]).toBe(url);
      const badUrl = await save(sourceAt("not a url"));
      expect(badUrl.status).toBe(400);
      expect(badUrl.body.message).toBe(
        `Invalid source.url: use the ${displayName} address, such as ${exampleUrl}.`,
      );
      const ftp = await save(sourceAt("ftp://source"));
      expect(ftp.status).toBe(400);
      expect(ftp.body.message).toBe(
        `Invalid source.url: use an http or https ${displayName} address without credentials or a query.`,
      );
      const badName = await save({ ...sourceAt(url), "source.auth_collection": "bad name" });
      expect(badName.status).toBe(400);
      expect(badName.body.message).toContain(
        `use ${/^[aeiou]/i.test(displayName) ? "an" : "a"} ${displayName} name`,
      );
      // The leaving filter's encoded topic must fit the realtime topic limit (2,500 characters
      // on both binaries, measured).
      const long = Array.from({ length: 100 }, () => "id != ''").join(" || ");
      const tooLong = await save({
        ...sourceAt(url),
        "source.users": { collection: "users", leaving_filter: long },
      });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.message).toContain("too long to subscribe to");
      expect((await settings())["source.connector"]).toBe(connector);
    });

    test("Test connection: every step passes on the fixture schema; missing fields and a wrong password are named", async () => {
      expect((await save(sourceAt(`http://localhost:${base.port}`))).status).toBe(200);
      const good = await call("POST", "/api/settings/source/test", {});
      expect(good.status).toBe(200);
      expect(good.body.data.ok, JSON.stringify(good.body)).toBe(true);
      expect(Object.keys(stepsOf(good))).toEqual(["auth", "recipients", "events", "users"]);
      const missing = await call("POST", "/api/settings/source/test", {
        "source.events": {
          collection: "events",
          user: "user",
          name: "title",
          data: "data",
          occurred_at: "occurredAt",
          key: "",
        },
        "source.recipients": { collection: "nobody", email: "email", name: "", opt_out: "" },
      });
      const steps = stepsOf(missing);
      expect(steps.recipients).toMatchObject({
        ok: false,
        message: "There is no collection nobody.",
      });
      expect(steps.events).toMatchObject({ ok: false, missing: ["title"] });
      const wrong = await call("POST", "/api/settings/source/test", {
        "source.password": "not-the-password",
      });
      expect(Object.keys(stepsOf(wrong))).toEqual(["auth"]);
      expect(stepsOf(wrong).auth?.ok).toBe(false);
    });

    test("Test connection fails a collection guests can read, naming it and its rule", async () => {
      expect((await save(sourceAt(`http://localhost:${base.port}`))).status).toBe(200);
      const user = await base.user();
      await base.event(user.id, "visit");
      for (const collection of ["events", "recipients"]) {
        await base.api("PATCH", `/api/collections/${collection}`, {
          listRule: "",
          viewRule: "",
        });
        try {
          const answer = await call("POST", "/api/settings/source/test", {});
          expect(answer.body.data.ok).toBe(false);
          expect(stepsOf(answer)[collection]?.message).toContain(`Guests can read ${collection}`);
          expect(stepsOf(answer).auth?.ok).toBe(true);
        } finally {
          await base.api("PATCH", `/api/collections/${collection}`, {
            listRule: SERVICE_RULE,
            viewRule: SERVICE_RULE,
          });
        }
      }
      expect((await call("POST", "/api/settings/source/test", {})).body.data.ok).toBe(true);
    });

    test("the private-address rule: an address literal and an unlisted name are refused; a listed name reads", async () => {
      expect((await save(sourceAt(`http://localhost:${base.port}`))).status).toBe(200);
      const literal = await call(
        "POST",
        "/api/settings/source/test",
        sourceAt(`http://127.0.0.1:${base.port}`),
      );
      expect(stepsOf(literal).auth?.ok).toBe(false);
      expect(stepsOf(literal).auth?.message).toContain("block_private_addresses");
      await setInstance({ "sources.private_hosts": [] });
      try {
        const unlisted = await call("POST", "/api/settings/source/test", {});
        expect(stepsOf(unlisted).auth?.ok).toBe(false);
        expect(stepsOf(unlisted).auth?.message).toContain("sources.private_hosts");
      } finally {
        await setInstance({ "sources.private_hosts": ["localhost"] });
      }
      expect((await call("POST", "/api/settings/source/test", {})).body.data.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe(`${connector}: adapter operations`, () => {
    test("recipient and record: the row, the opt-out field, and null for an absent ID", async () => {
      const { source } = adapter();
      const user = await base.user({ name: "Ada", marketingOptOut: true });
      const left = await base.user();
      await base.update("users", left.id, { deletedAt: new Date().toISOString() });
      expect(await source.recipient(user.id)).toMatchObject({
        id: user.id,
        email: user.email,
        name: "Ada",
        optOut: true,
      });
      expect(await source.recipient(left.id)).toBeNull();
      expect(await source.recipient("nosuchuser00000")).toBeNull();
      const made = await base.event(user.id, "visit", { plan: "pro" }, { key: unique("k") });
      expect(await source.record(made.id)).toMatchObject({
        id: made.id,
        user: user.id,
        name: "visit",
        data: { plan: "pro" },
      });
      expect(await source.record("nosuchrecord000")).toBeNull();
      expect((await failure(source.record("a' || id != '"))).kind).toBe("notFound");
    });

    test("latest, count and exists: the user, names, a strict window and data equality", async () => {
      const { source } = adapter();
      const user = await base.user();
      const times = [
        "2026-05-01T00:00:00.000Z",
        "2026-05-02T00:00:00.000Z",
        "2026-05-03T00:00:00.000Z",
      ];
      for (const [index, time] of times.entries()) {
        await base.event(
          user.id,
          "visit",
          { plan: index === 2 ? "pro" : "free", n: index },
          { occurredAt: time },
        );
      }
      await base.event(user.id, "signup", {}, { occurredAt: "2026-04-01T00:00:00.000Z" });
      expect((await source.latest({ user: user.id, names: ["visit"] }))?.occurredAt).toEqual(
        new Date(times[2]!),
      );
      expect(await source.latest({ user: user.id, names: ["nothing"] })).toBeNull();
      expect(await source.count({ user: user.id, names: ["visit"] }, 10)).toBe(3);
      expect(await source.count({ user: user.id, names: ["visit"] }, 2)).toBe(2);
      expect(
        await source.count(
          {
            user: user.id,
            names: ["visit"],
            after: new Date(times[0]!),
            through: new Date(times[1]!),
          },
          10,
        ),
      ).toBe(1);
      expect(await source.count({ user: user.id, data: { plan: "pro" } }, 10)).toBe(1);
      expect(await source.count({ user: user.id, data: { n: 1 } }, 10)).toBe(1);
      expect(await source.exists({ user: user.id, names: ["signup"] })).toBe(true);
      expect(await source.exists({ user: user.id, names: ["nothing"] })).toBe(false);
    });

    test("scan: keyset pages of at most 1000 with skipTotal, ties included, stopping at the limit", async () => {
      await enableBatch(base);
      const user = await base.user();
      const start = Date.parse("2026-07-01T00:00:00.000Z");
      // 2,100 records, three on each instant, so pages break inside a tie.
      for (let from = 0; from < 2100; from += 700) {
        const requests = Array.from({ length: 700 }, (_, offset) => ({
          method: "POST",
          url: "/api/collections/events/records",
          body: {
            user: user.id,
            name: "tick",
            data: { i: from + offset },
            occurredAt: new Date(start + Math.floor((from + offset) / 3) * 1000).toISOString(),
          },
        }));
        await base.api("POST", "/api/batch", { requests });
      }
      const pages: Array<string> = [];
      const source = connectors[connector].create({
        config: sourceConfig(base.url, base.service),
        clock: createRealClock(),
        guard: openGuard,
        transport: {
          fetch(input: URL, init: RequestInit) {
            if (input.pathname === "/api/collections/events/records") {
              pages.push(input.search);
            }
            return fetch(input, init);
          },
        },
      });
      const sizes: Array<number> = [];
      const seen = new Set<string>();
      let previous = "";
      for await (const page of source.scan({ user: user.id, names: ["tick"] }, ["data"], 5000)) {
        sizes.push(page.length);
        for (const row of page) {
          const keyOf = `${row.occurredAt.toISOString()}|${row.id}`;
          expect(keyOf > previous).toBe(true);
          previous = keyOf;
          seen.add(row.id);
          expect(row.data).toHaveProperty("i");
        }
      }
      expect(sizes).toEqual([1000, 1000, 100]);
      expect(seen.size).toBe(2100);
      for (const search of pages) {
        const params = new URLSearchParams(search);
        expect(params.get("skipTotal")).toBe("1");
        expect(Number(params.get("perPage"))).toBeLessThanOrEqual(1000);
      }
      let total = 0;
      for await (const page of source.scan({ user: user.id }, [], 1500)) {
        total += page.length;
      }
      expect(total).toBe(1500);
      expect(await source.count({ user: user.id, names: ["tick"] }, 2050)).toBe(2050);
    });

    test("hostile literals read back exactly: quotes, backslashes, && and ||, unicode", async () => {
      const { source } = adapter();
      const user = await base.user();
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
      ];
      for (const name of hostile) {
        await base.event(user.id, name, { s: name });
      }
      for (const name of hostile) {
        expect(await source.count({ user: user.id, names: [name] }, 100)).toBe(1);
        expect((await source.latest({ user: user.id, names: [name] }))?.name).toBe(name);
        expect(await source.count({ user: user.id, data: { s: name } }, 100)).toBe(1);
      }
      expect((await failure(source.count({ user: "a' || user != '" }, 10))).kind).toBe("notFound");
    });

    test("the token is renewed half way to its expiry on the injected clock", async () => {
      const clock = new TestClock();
      const { source, signIns } = adapter({ clock });
      const user = await base.user();
      await source.recipient(user.id);
      expect(signIns()).toBe(1);
      // A new auth collection's token lasts 5 days on both binaries (D189).
      clock.advance(2 * day);
      await source.recipient(user.id);
      expect(signIns()).toBe(1);
      clock.advance(day);
      await source.recipient(user.id);
      expect(signIns()).toBe(2);
    });

    test(`D189: a revoked token (${target.revokedToken === 401 ? "answered 401" : "read as a guest"}) is noticed: every read gives the right answer`, async () => {
      const { source, answers } = adapter();
      const user = await base.user();
      const made = await base.event(user.id, "revoked", {});
      expect(await source.count({ user: user.id }, 10)).toBe(1);
      const reads: Array<() => Promise<unknown>> = [
        async () => expect((await source.recipient(user.id))?.id).toBe(user.id),
        async () => expect((await source.record(made.id))?.id).toBe(made.id),
        async () => expect(await source.count({ user: user.id }, 10)).toBe(1),
        async () => expect(await source.exists({ user: user.id })).toBe(true),
        async () => expect((await source.latest({ user: user.id }))?.id).toBe(made.id),
      ];
      for (const read of reads) {
        await revokeTokens(base);
        const from = answers.length;
        await read();
        const refused = answers
          .slice(from)
          .filter((line) => /\/records(\/\w+)? 401$/.test(line)).length;
        // The difference is met: iglo.base refuses the read itself, PocketBase answers it as a
        // guest's and the token check after it refuses the token.
        expect(refused > 0).toBe(target.revokedToken === 401);
      }
    });

    test("errors: a wrong password and a missing collection are permanent; a paused server times out as transient", async () => {
      const wrong = await failure(
        adapter({ config: { password: "not-the-password" } }).source.recipient("nosuchuser00000"),
      );
      expect(wrong.kind).toBe("permanent");
      expect(isAuthRefused(wrong)).toBe(true);
      const nobody = adapter({
        config: { recipients: { collection: "nobody", email: "email", name: "", optOut: "" } },
      });
      expect((await failure(nobody.source.recipient("nosuchuser00000"))).kind).toBe("permanent");
      const { source } = adapter();
      const user = await base.user();
      await source.recipient(user.id);
      await base.pause();
      try {
        const slow = await failure(source.recipient(user.id, { timeoutMs: 300 }));
        expect(slow.kind).toBe("transient");
        expect(slow.message).toBe("The source did not answer in time");
      } finally {
        base.resume();
      }
      expect((await source.recipient(user.id))?.id).toBe(user.id);
    });

    test("errors: a renamed field is permanent; a stopped server is transient", async () => {
      const local = await target.start();
      try {
        const source = connectors[connector].create({
          config: sourceConfig(local.url, local.service),
          clock: createRealClock(),
          guard: openGuard,
        });
        const user = await local.user();
        await local.event(user.id, "renamed", {});
        expect(await source.count({ user: user.id }, 10)).toBe(1);
        await local.renameField("events", "occurredAt", "happenedAt");
        const renamed = await failure(source.count({ user: user.id }, 10));
        expect(renamed.kind).toBe("permanent");
        expect(renamed.status).toBe(400);
        await local.stop();
        expect((await failure(source.recipient(user.id))).kind).toBe("transient");
      } finally {
        await local.close();
      }
    });

    test("the private-address guard: refused unless the host is listed; an address literal never is", async () => {
      const user = await base.user();
      const blocked: Guard = { blockPrivate: () => true, privateHosts: () => [] };
      const refused = await failure(adapter({ guard: blocked }).source.recipient(user.id));
      expect(refused.kind).toBe("permanent");
      expect(refused.message).toContain("block_private_addresses");
      const named = `http://localhost:${base.port}`;
      const listed: Guard = { blockPrivate: () => true, privateHosts: () => ["localhost"] };
      expect(
        (await adapter({ guard: listed, config: { url: named } }).source.recipient(user.id))?.id,
      ).toBe(user.id);
      const literal: Guard = { blockPrivate: () => true, privateHosts: () => ["127.0.0.1"] };
      expect((await failure(adapter({ guard: literal }).source.recipient(user.id))).kind).toBe(
        "permanent",
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  describe(`${connector}: the realtime stream`, () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
      }
    });
    function stream(options: Omit<Parameters<typeof startStream>[0], "connector">): StreamFixture {
      const fixture = startStream({ ...options, connector });
      cleanups.push(() => fixture.close());
      return fixture;
    }

    test("live delivery: subscribed names arrive once, others never; a user leaving arrives", async () => {
      const name = unique("live");
      const s = stream({ config: sourceConfig(base.url, base.service), names: () => [name] });
      await s.live();
      const user = await base.user();
      const wanted = await base.event(user.id, name, { n: 1 });
      await base.event(user.id, unique("other"), {});
      const second = await base.event(user.id, name, { n: 2 });
      await base.update("users", user.id, { deletedAt: new Date().toISOString() });
      await s.until(
        () => s.eventIds().length === 2 && s.handled.some((entry) => entry.kind === "user"),
        "the records",
      );
      expect(sorted(s.eventIds())).toEqual(sorted([wanted.id, second.id]));
      expect(s.handled.filter((entry) => entry.kind === "user").map((e) => e.id)).toEqual([
        user.id,
      ]);
      expect(s.attention).toEqual([]);
    });

    test("a cut connection: records made meanwhile are caught up, none lost, none twice, no attention", async () => {
      const name = unique("cut");
      const cut = startCutProxy(base.port);
      cleanups.push(() => cut.stop());
      const s = stream({ config: eventsOnly(cut.url), names: () => [name] });
      await s.live();
      const user = await base.user();
      const before = await base.event(user.id, name);
      await s.until(() => s.eventIds().length === 1, "the first record");
      const sessions = s.stream.state().sessions;
      cut.cut();
      const meanwhile: Array<string> = [];
      for (let i = 0; i < 5; i++) {
        meanwhile.push((await base.event(user.id, name, { i })).id);
      }
      await s.until(() => s.stream.state().sessions > sessions, "a new session");
      await s.live();
      const after = await base.event(user.id, name);
      await s.until(() => s.eventIds().length === 7, "every record");
      expect(sorted(s.eventIds())).toEqual(sorted([before.id, ...meanwhile, after.id]));
      expect(s.attention).toEqual([]);
    });

    test(`D189: a reader fallen 8 MiB behind (${target.closesWhenBehind ? "closed" : "kept"} by the binary): none lost, none twice, no attention`, async () => {
      const name = unique("behind");
      const proxy = await startStallProxy(base.port);
      cleanups.push(() => proxy.stop());
      const s = stream({ config: eventsOnly(proxy.url), names: () => [name] });
      await s.live();
      const sessions = s.stream.state().sessions;
      await proxy.stall();
      const user = await base.user();
      const blob = "x".repeat(200_000);
      const made: Array<string> = [];
      // 30 MB of messages: past iglo.base's 8 MiB of unsent data with the socket buffers full.
      for (let i = 0; i < 150; i++) {
        made.push((await base.event(user.id, name, { i, blob })).id);
      }
      // Real time for the binary to write what the sockets take and give up on the rest.
      await Bun.sleep(2000);
      proxy.release();
      await s.until(() => new Set(s.eventIds()).size === 150, "every record", 60_000);
      await s.live();
      expect(sorted(s.eventIds())).toEqual(sorted(made));
      expect(s.eventIds().length).toBe(150);
      expect(s.attention).toEqual([]);
      // The difference is met: iglo.base closed the connection and the stream connected again;
      // PocketBase kept it, and anything past the stream's own buffer was caught up on it.
      expect(s.stream.state().sessions > sessions).toBe(target.closesWhenBehind);
    });

    test(`D189: a revoked token on the subscription (${target.revokedToken === 401 ? "answered 401" : "read as a guest"}): the stream signs in again and delivers`, async () => {
      const name = unique("resub");
      const cut = startCutProxy(base.port);
      cleanups.push(() => cut.stop());
      const s = stream({ config: eventsOnly(cut.url), names: () => [name] });
      await s.live();
      const sessions = s.stream.state().sessions;
      await revokeTokens(base);
      const from = s.answers.length;
      cut.cut();
      await s.until(() => s.stream.state().sessions > sessions, "a new session");
      await s.live();
      const user = await base.user();
      const made = await base.event(user.id, name);
      await s.until(() => s.eventIds().length === 1, "the record");
      expect(s.eventIds()).toEqual([made.id]);
      expect(s.attention).toEqual([]);
      const subscriptions = s.answers
        .slice(from)
        .filter((line) => line.startsWith("POST /api/realtime"));
      expect(subscriptions.some((line) => line.endsWith(" 401"))).toBe(target.revokedToken === 401);
      expect(subscriptions.at(-1)).toMatch(/ 204$/);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe(`${connector}: the record handler and the send-time lookup`, () => {
    interface Records {
      f: SchedulerFixture;
      records: SourceRecords;
      outcomes: Array<RecordOutcome>;
      attention: Array<string>;
      rules: { current: Array<GrantRule> };
      ev: (name: string) => string;
    }
    const open: Array<Records> = [];
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const h of open.splice(0)) {
        await h.records.stop();
        await h.f.close();
      }
      for (const close of closers.splice(0)) {
        await close();
      }
    });

    async function until(h: Records, check: () => boolean | Promise<boolean>, what: string) {
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

    async function records(): Promise<Records> {
      const f = await schedulerFixture({
        source: () =>
          connectors[connector].create({
            config: sourceConfig(base.url, base.service),
            clock: createRealClock(),
            guard: openGuard,
          }),
      });
      const outcomes: Array<RecordOutcome> = [];
      const attention: Array<string> = [];
      const rules = { current: [] as Array<GrantRule> };
      const handler = createSourceRecords({
        db: f.db,
        clock: f.clock,
        logger: {
          attention: (message) => attention.push(message),
          error: (error) => attention.push(`error: ${String(error)}`),
        },
        setup: () => ({ connector, config: sourceConfig(base.url, base.service) }),
        grantRules: () => rules.current,
        guard: openGuard,
        subscribers: f.stores.subscribers,
        enrollments: f.stores.enrollments,
        emailAllowed: () => true,
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      handler.start();
      const tag = crypto.randomUUID().slice(0, 8);
      const h: Records = {
        f,
        records: handler,
        outcomes,
        attention,
        rules,
        ev: (name) => `${name}_${tag}`,
      };
      open.push(h);
      await until(
        h,
        () => ["live", "idle"].includes(h.records.stream()?.state().state ?? ""),
        "the first session",
      );
      return h;
    }
    /** Waits until the stream has subscribed to the names as they are now. */
    async function resubscribed(h: Records) {
      const before = h.records.stream()?.state().sessions ?? 0;
      h.f.clock.advance(TOPIC_CHECK_MS);
      await until(h, () => (h.records.stream()?.state().sessions ?? 0) > before, "a new session");
      await until(h, () => h.records.stream()?.state().state === "live", "the stream live");
    }
    const handled = (h: Records, record: { id: string }) =>
      until(h, () => h.outcomes.some((o) => o.record === record.id), `record ${record.id}`);
    const outcomeOf = (h: Records, record: { id: string }) =>
      h.outcomes.find((o) => o.record === record.id);
    const record = (h: Records, user: PocketBaseRecord, name: string, data: JsonObject = {}) =>
      base.event(user.id, h.ev(name), data, { occurredAt: h.f.clock.now().toISOString() });
    async function linked(h: Records, user: PocketBaseRecord) {
      const r = await h.f.json(`/api/subscribers/external/${user.id}`);
      return r.status === 200
        ? asBody<{
            id: number;
            email: string;
            name: string;
            lists: Array<{ id: number; subscription_status: string }>;
          }>(r.body.data)
        : null;
    }

    test("a record upserts its subscriber from the view and starts the external sequence; a user leaving removes it", async () => {
      const h = await records();
      const template = await h.f.template();
      const seq = await h.f.sequence({
        source: "external",
        trigger: { event: h.ev("order_paid") },
        steps: [tx(template)],
      });
      await resubscribed(h);
      const ana = await base.user({ name: "  Ana Maria  " });
      const paid = await record(h, ana, "order_paid");
      await handled(h, paid);
      const subscriber = await linked(h, ana);
      expect(subscriber).toMatchObject({ email: ana.email, name: "Ana Maria" });
      const enrollments = await h.f.json(
        `/api/enrollments?subscriber_id=${subscriber?.id ?? 0}&per_page=50`,
      );
      expect(enrollments.body.data.results[0]).toMatchObject({
        sequence_id: seq.id,
        status: "active",
        trigger_external_id: paid.id,
      });
      await base.update("users", ana.id, { deletedAt: new Date().toISOString() });
      await until(
        h,
        () => h.outcomes.some((o) => o.record === ana.id && o.kind === "left"),
        "leaving",
      );
      expect(await linked(h, ana)).toBeNull();
      expect(h.attention).toEqual([]);
    });

    test("grant_lists: added, and refused for an opt-out, an unsubscribe and a deleted list", async () => {
      const h = await records();
      const news = await h.f.list("News");
      const gone = await h.f.list("Gone");
      await h.f.json(`/api/lists/${gone}`, "DELETE");
      h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news, gone] }];
      await resubscribed(h);
      const plain = await base.user();
      const optedOut = await base.user({ marketingOptOut: true });
      const left = await base.user();
      const leftId = await h.f.json("/api/subscribers", "POST", {
        name: "Left",
        email: emailOf(left),
        external_id: left.id,
        lists: [news],
        preconfirm_subscriptions: true,
      });
      await h.f.json("/api/subscribers/lists", "PUT", {
        ids: [leftId.body.data.id],
        action: "unsubscribe",
        target_list_ids: [news],
      });
      const grants = new Map<string, unknown>();
      for (const user of [plain, optedOut, left]) {
        const signup = await record(h, user, "signup");
        await handled(h, signup);
        grants.set(user.id, outcomeOf(h, signup)?.grants);
      }
      expect(grants.get(plain.id)).toEqual([
        { list_id: news, result: "added" },
        { list_id: gone, result: "unavailable" },
      ]);
      expect(asBody<Array<unknown>>(grants.get(optedOut.id))[0]).toEqual({
        list_id: news,
        result: "opted_out",
      });
      expect(asBody<Array<unknown>>(grants.get(left.id))[0]).toEqual({
        list_id: news,
        result: "unsubscribed",
      });
      const status = async (user: PocketBaseRecord) =>
        (await linked(h, user))?.lists.find((l) => l.id === news)?.subscription_status ?? null;
      expect(await status(plain)).toBe("confirmed");
      expect(await status(optedOut)).toBeNull();
      expect(await status(left)).toBe("unsubscribed");
    });

    test("the send-time lookup: a step goes to the source's current name and address; a deleted user gets nothing", async () => {
      const source = connectors[connector].create({
        config: sourceConfig(base.url, base.service),
        clock: createRealClock(),
        guard: openGuard,
      });
      const f = await schedulerFixture({ source: () => source, sendTime: true });
      closers.push(() => f.close());
      const template = await f.template("<p>Hi {{ subscriber.name }}|{{ subscriber.email }}</p>");
      const enrol = async (user: PocketBaseRecord) => {
        const id = await f.subscriber(emailOf(user), { external_id: user.id, name: "Stale" });
        const seq = await f.sequence({
          source: "external",
          trigger: { event: unique("order_paid") },
          steps: [tx(template)],
        });
        const r = await f.json("/api/enrollments", "POST", {
          sequence_id: seq.id,
          subscriber_id: id,
        });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        return id;
      };
      const ana = await base.user({ name: "Ana" });
      const bob = await base.user({ name: "Bob" });
      await enrol(ana);
      const bobId = await enrol(bob);
      const moved = `moved-${crypto.randomUUID().slice(0, 8)}@example.com`;
      await base.update("users", ana.id, { email: moved, name: "Zoë" });
      await base.remove("users", bob.id);
      await f.pass(day);
      await f.until(() => f.sink.messages.length === 1, "the step");
      expect(f.sink.messages[0]!.to).toEqual([moved]);
      expect(f.sink.messages[0]!.data).toContain(moved);
      await f.until(
        async () => (await f.json(`/api/subscribers/${bobId}`)).status !== 200,
        "the removal",
      );
      await f.pass(day);
      expect(f.sink.messages.length).toBe(1);
    });
  });
}
