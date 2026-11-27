// B162b (15-external-sources sections 8 and 9, D187, D189): the iglo.base 1.3.0 harness, and the
// section 9 facts measured side by side on PocketBase 0.40.5 and iglo.base 1.3.0 (a port of
// PocketBase 0.42.3). Each fact is one test per binary; where the two differ, the expected value is
// named per binary so the difference stays visible. Both run as real release binaries, no mock.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createPocketBaseSource } from "@/sources/pocketbase";
import { asBody, readJson } from "@/test/read-body";
import { IGLO_BASE_VERSION, igloBaseBinary } from "@/test/sources/iglo-base-binary";
import { igloBaseCommand, startIgloBase } from "@/test/sources/iglo-base";
import { pocketBaseBinary } from "@/test/sources/pocketbase-binary";
import {
  SERVICE_IDENTITY,
  SERVICE_PASSWORD,
  sourceConfig,
  startPocketBase,
} from "@/test/sources/pocketbase";
import type { PocketBase } from "@/test/sources/pocketbase";

setDefaultTimeout(60_000);

type Binary = "pocketbase" | "iglo.base";
type Item = { id: string; name?: string; email?: string };
/** The fields of an API answer the tests read. */
type Answer = Item & {
  items: Array<Item>;
  message: string;
  perPage: number;
  totalItems: number;
  totalPages: number;
};
type Message = { event: string; data: { action: string; record: Item } };

async function versionLine(binary: string): Promise<string> {
  const child = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return out.trim();
}

test("smoke: the pinned iglo.base binary prints its version, serves the fixture schema and records", async () => {
  const version = (await igloBaseCommand(["--version"])).trim();
  console.log(version);
  expect(version).toBe(`iglo-base version ${IGLO_BASE_VERSION}`);
  const ib = await startIgloBase();
  try {
    const health = await fetch(`${ib.url}/api/health`);
    expect(health.status).toBe(200);
    const collections = asBody<{ items: Array<{ name: string; type: string }> }>(
      await ib.api("GET", "/api/collections?perPage=200"),
    );
    const names = collections.items.map((item) => `${item.name}:${item.type}`);
    expect(names).toEqual(
      expect.arrayContaining(["services:auth", "users:auth", "events:base", "recipients:view"]),
    );
    const user = await ib.user({ name: "Ada Smoke" });
    const event = await ib.event(user.id, "signed_up", { plan: "pro" }, { key: "smoke-1" });
    const leaving = await ib.user();
    await ib.update("users", leaving.id, {
      deletedAt: new Date().toISOString(),
    });

    // The PocketBase adapter signs in to the service account and reads the fixture through it.
    const source = createPocketBaseSource({
      config: sourceConfig(ib.url, ib.service),
      clock: createRealClock(),
      guard: { blockPrivate: () => false, privateHosts: () => [] },
    });
    await source.authenticate();
    expect(await source.recipient(user.id)).toMatchObject({
      email: user.email,
      name: "Ada Smoke",
    });
    expect(await source.recipient(leaving.id)).toBeNull();
    expect(await source.record(event.id)).toMatchObject({
      id: event.id,
      user: user.id,
      name: "signed_up",
      data: { plan: "pro" },
      key: "smoke-1",
    });

    // Stop, start on the same port and data: the records are still there.
    await ib.stop();
    await ib.start();
    expect((await ib.api("GET", `/api/collections/events/records/${event.id}`)).key).toBe(
      "smoke-1",
    );
  } finally {
    await ib.close();
  }
});

test("both pinned binaries print their own version line", async () => {
  expect(await versionLine(await pocketBaseBinary())).toBe("pocketbase version 0.40.5");
  expect(await versionLine(await igloBaseBinary())).toBe("iglo-base version 1.3.0");
});

/** A realtime client: the SSE messages of one connection, by topic. */
async function realtime(base: PocketBase, token: string, topics: Array<string>, status = 204) {
  const controller = new AbortController();
  const response = await fetch(`${base.url}/api/realtime`, {
    signal: controller.signal,
  });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const messages: Array<Message> = [];
  let buffer = "";
  const { promise: clientId, resolve: connected } = Promise.withResolvers<string>();
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        buffer += value;
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf("\n\n");
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) {
              event = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              data += line.slice(5).trim();
            }
          }
          if (event === "PB_CONNECT") {
            connected(asBody<{ clientId: string }>(JSON.parse(data)).clientId);
          } else {
            messages.push({ event, data: asBody<Message["data"]>(JSON.parse(data)) });
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();
  const id = await clientId;
  const subscribed = await fetch(`${base.url}/api/realtime`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: id, subscriptions: topics }),
  });
  expect(subscribed.status).toBe(status);
  return {
    messages,
    async until(match: (message: Message) => boolean) {
      const deadline = Date.now() + 10_000;
      while (!messages.some(match)) {
        if (Date.now() > deadline) {
          throw new Error(`no realtime message matched: ${JSON.stringify(messages)}`);
        }
        await Bun.sleep(10);
      }
    },
    async close() {
      controller.abort();
      await pump;
    },
  };
}

const harnesses: Array<[Binary, () => Promise<PocketBase>]> = [
  ["pocketbase", startPocketBase],
  ["iglo.base", startIgloBase],
];

describe.each(harnesses)("section 9 facts on %s", (binary, start) => {
  let base: PocketBase;
  let service = "";

  /** A GET as the service account; the status and the parsed body. */
  async function read(path: string, token = service) {
    const response = await fetch(`${base.url}${path}`, {
      headers: { Authorization: token },
    });
    const text = await response.text();
    return { status: response.status, body: asBody<Answer>(text ? JSON.parse(text) : {}) };
  }
  const list = (collection: string, query: Record<string, string>, token = service) =>
    read(`/api/collections/${collection}/records?${new URLSearchParams(query)}`, token);
  async function signIn(): Promise<string> {
    const response = await fetch(`${base.url}/api/collections/services/auth-with-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: SERVICE_IDENTITY,
        password: SERVICE_PASSWORD,
      }),
    });
    expect(response.status).toBe(200);
    return (await readJson<{ token: string }>(response)).token;
  }

  beforeAll(async () => {
    base = await start();
    service = await signIn();
  });
  afterAll(async () => {
    await base?.close();
  });

  test("filters on JSON data are loose for > and booleans, exact for =, and != includes missing keys", async () => {
    const user = await base.user();
    const tag = crypto.randomUUID().slice(0, 8);
    const made: Record<string, string> = {};
    for (const [label, data] of Object.entries({
      number10: { n: 10 },
      string10: { n: "10" },
      boolTrue: { b: true },
      one: { b: 1 },
      missing: {},
      empty: { n: "" },
    })) {
      made[(await base.event(user.id, tag, data)).id] = label;
    }
    const matching = async (filter: string) => {
      const answer = await list("events", {
        filter: `name = '${tag}' && (${filter})`,
      });
      expect(answer.status).toBe(200);
      return answer.body.items
        .map((item) => made[item.id] ?? item.id)
        .sort((a, b) => a.localeCompare(b));
    };
    // SQLite compares any text as greater than any number, so "10" and "" both pass `> 5`.
    expect(await matching("data.n > 5")).toEqual(["empty", "number10", "string10"]);
    expect(await matching("data.b = true")).toEqual(["boolTrue", "one"]);
    expect(await matching("data.b = 1")).toEqual(["boolTrue", "one"]);
    expect(await matching("data.n = 10")).toEqual(["number10"]);
    expect(await matching("data.n = '10'")).toEqual(["string10"]);
    expect(await matching("data.n = null")).toEqual(["boolTrue", "missing", "one"]);
    expect(await matching("data.n = ''")).toEqual(["empty"]);
    expect(await matching("data.n != 10")).toEqual([
      "boolTrue",
      "empty",
      "missing",
      "one",
      "string10",
    ]);
  });

  test("perPage is capped at 1000 and skipTotal answers totalItems -1", async () => {
    const capped = await list("events", { perPage: "5000" });
    expect(capped.status).toBe(200);
    expect(capped.body.perPage).toBe(1000);
    const skipped = await list("events", { perPage: "1", skipTotal: "1" });
    expect(skipped.body).toMatchObject({ totalItems: -1, totalPages: -1 });
  });

  test("a duplicate unique value is a 400 validation_not_unique on the field", async () => {
    const user = await base.user();
    const key = `dup-${crypto.randomUUID()}`;
    await base.event(user.id, "dup", {}, { key });
    let duplicate: unknown;
    try {
      await base.event(user.id, "dup", {}, { key });
    } catch (error) {
      duplicate = error;
    }
    expect(String(duplicate)).toContain(" 400 ");
    expect(String(duplicate)).toContain('"key":{"code":"validation_not_unique"');
  });

  test("an auth collection hides email from a non-owner unless emailVisibility is on", async () => {
    const hidden = await base.user();
    const shown = await base.user({ emailVisibility: true });
    const one = async (id: string) => (await read(`/api/collections/users/records/${id}`)).body;
    expect((await one(hidden.id)).email).toBeUndefined();
    expect((await one(shown.id)).email).toBe(String(shown.email));
    // The recipients view selects the column, so it carries the address either way.
    expect((await read(`/api/collections/recipients/records/${hidden.id}`)).body.email).toBe(
      String(hidden.email),
    );
  });

  test("an unknown, invalid or revoked token: guest on 0.40.5, 401 on every route on iglo.base", async () => {
    const user = await base.user();
    // A token of a second service account whose password is then changed (its tokenKey moves).
    const extra = await base.create("services", {
      email: `revoked-${crypto.randomUUID().slice(0, 8)}@example.com`,
      password: "revoked-password-1",
      passwordConfirm: "revoked-password-1",
    });
    const signedIn = await fetch(`${base.url}/api/collections/services/auth-with-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: extra.email,
        password: "revoked-password-1",
      }),
    });
    const revoked = (await readJson<{ token: string }>(signedIn)).token;
    expect((await read(`/api/collections/recipients/records/${user.id}`, revoked)).status).toBe(
      200,
    );
    await base.update("services", extra.id, {
      password: "revoked-password-2",
      passwordConfirm: "revoked-password-2",
    });
    const refresh = async (token: string) =>
      (
        await fetch(`${base.url}/api/collections/services/auth-refresh`, {
          method: "POST",
          headers: { Authorization: token },
        })
      ).status;
    for (const token of [revoked, "not-a-token"]) {
      const listed = await list("recipients", { filter: `id = '${user.id}'` }, token);
      const viewed = await read(`/api/collections/recipients/records/${user.id}`, token);
      if (binary === "pocketbase") {
        expect(listed.status).toBe(200);
        expect(listed.body.items).toEqual([]);
        expect(viewed.status).toBe(404);
      } else {
        expect(listed.status).toBe(401);
        expect(viewed.status).toBe(401);
        expect(viewed.body.message).toBe("Missing or invalid authentication.");
      }
      expect(await refresh(token)).toBe(401);
      // A realtime subscription with the token: accepted as a guest's, or refused.
      const client = await realtime(base, token, ["events/*"], binary === "pocketbase" ? 204 : 401);
      await client.close();
    }
    expect(await refresh(service)).toBe(200);
  });

  test("a guest (no Authorization header) lists no fixture records and views none", async () => {
    const user = await base.user();
    const event = await base.event(user.id, "guest-check", {});
    const guest = async (path: string) => {
      const response = await fetch(`${base.url}${path}`);
      const text = await response.text();
      return { status: response.status, body: asBody<Answer>(text ? JSON.parse(text) : {}) };
    };
    for (const [collection, id] of [
      ["events", event.id],
      ["recipients", user.id],
      ["users", user.id],
    ] as const) {
      // The service account can read the record, so an empty answer is the rule, not a miss.
      expect((await read(`/api/collections/${collection}/records/${id}`)).status).toBe(200);
      const listed = await guest(`/api/collections/${collection}/records`);
      expect({ collection, status: listed.status, items: listed.body.items }).toEqual({
        collection,
        status: 200,
        items: [],
      });
      const viewed = await guest(`/api/collections/${collection}/records/${id}`);
      expect({ collection, status: viewed.status }).toEqual({ collection, status: 404 });
    }
  });

  test("filter literals: backslash escaping reads back exactly; unknown fields are a 400", async () => {
    const user = await base.user();
    const hostile = `it's a \\ trap\\`;
    await base.event(user.id, hostile, {});
    const escaped = hostile.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`);
    const exact = await list("events", { filter: `name = '${escaped}'` });
    expect(exact.status).toBe(200);
    expect(exact.body.items.map((item) => item.name)).toEqual([hostile]);
    const quoteOnly = await list("events", {
      filter: `name = '${hostile.replaceAll("'", String.raw`\'`)}'`,
    });
    expect(quoteOnly.status).toBe(400);
    for (const query of [{ filter: "nope = 1" }, { sort: "nope" }]) {
      const unknown = await list("events", query);
      expect(unknown.status).toBe(400);
      expect(unknown.body.message).toBe("Something went wrong while processing your request.");
    }
  });

  test("dates are stored as YYYY-MM-DD HH:mm:ss.sssZ text and compare as text", async () => {
    const user = await base.user();
    const tag = crypto.randomUUID().slice(0, 8);
    const event = await base.event(user.id, tag, {}, { occurredAt: "2026-11-25T10:20:30.456Z" });
    expect(event.occurredAt).toBe("2026-11-25 10:20:30.456Z");
    const after = await list("events", {
      filter: `name = '${tag}' && occurredAt > '2026-11-25 10:20:30.455Z'`,
    });
    expect(after.body.items).toHaveLength(1);
  });

  test("a new auth collection's token lasts 5 days; the minimum is 10 s", async () => {
    const collection = asBody<{ authToken: { duration: number } }>(
      await base.api("GET", "/api/collections/services"),
    );
    expect(collection.authToken.duration).toBe(432_000);
    let refused: unknown;
    try {
      await base.api("PATCH", "/api/collections/services", {
        authToken: { duration: 9 },
      });
    } catch (error) {
      refused = error;
    }
    expect(String(refused)).toContain(" 400 ");
    const payload = asBody<{ exp: number }>(
      JSON.parse(atob(service.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/"))),
    );
    expect(Math.abs(payload.exp - Date.now() / 1000 - 432_000)).toBeLessThan(120);
  });

  test("realtime: a subscription filter applies to every action, so a non-matching delete is not sent", async () => {
    const tag = `rt-${crypto.randomUUID().slice(0, 8)}`;
    const options = encodeURIComponent(JSON.stringify({ query: { filter: `name = '${tag}'` } }));
    const client = await realtime(base, service, [`users/*?options=${options}`]);
    try {
      const matching = await base.user({ name: tag });
      const other = await base.user({ name: `${tag}-other` });
      await base.remove("users", other.id);
      await base.remove("users", matching.id);
      await client.until(
        (message) => message.data?.action === "delete" && message.data.record.id === matching.id,
      );
      const seen = client.messages.map(
        (message) => `${message.data.action}:${message.data.record.id}`,
      );
      expect(seen.sort()).toEqual([`create:${matching.id}`, `delete:${matching.id}`].sort());
    } finally {
      await client.close();
    }
  });

  test("realtime: each record created in one batch request is sent", async () => {
    await base.api("PATCH", "/api/settings", {
      batch: { enabled: true, maxRequests: 50 },
    });
    const user = await base.user();
    const tag = `batch-${crypto.randomUUID().slice(0, 8)}`;
    const client = await realtime(base, service, ["events/*"]);
    try {
      await base.api("POST", "/api/batch", {
        requests: [1, 2, 3].map((n) => ({
          method: "POST",
          url: "/api/collections/events/records",
          body: { user: user.id, name: tag, key: `${tag}-${n}` },
        })),
      });
      await client.until(
        () => client.messages.filter((message) => message.data?.record?.name === tag).length === 3,
      );
      const created = client.messages.filter((message) => message.data.record.name === tag);
      expect(created.map((message) => message.data.action)).toEqual(["create", "create", "create"]);
    } finally {
      await client.close();
    }
  });
});
