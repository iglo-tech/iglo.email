import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { createListStore } from "@/lists/store";
import { createListCounts } from "@/subscribers/list-counts";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { createSubscriberStore } from "@/subscribers/store";
import { createRoles } from "@/roles/roles";
import { createRouter } from "@/server/server";
import { TestClock } from "@/test/server/fixture";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { createUserStore } from "@/users/store";
import { createEmailer, type Message } from "@/messaging/email";
import { startOutbox } from "@/messaging/outbox";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { createSends } from "@/messaging/sends";
import { registerSendRoutes } from "@/messaging/routes";

const message = () => ({
  from: "sender@example.test",
  to: ["recipient@example.test"],
  subject: "synthetic subject",
  contentType: "plain" as const,
  body: Buffer.from("private body"),
  headers: { "X-Fixture": "private header" },
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "iglo-sends-"));
  const clock = new TestClock();
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const lists = createListReferences(db),
    counts = createListCounts(db),
    campaigns = createCampaignListReferences(db),
    listStore = createListStore(db, clock, counts, campaigns),
    subscribers = createSubscriberStore(db, clock, lists),
    roles = createRoles(db, lists),
    users = createUserStore(db, clock, roles);
  const auth = await createAuthentication(
    users,
    roles,
    clock,
    "http://fixture.test",
    defaultAuthPolicy,
  );
  await bootstrapAdmin(users, auth, { user: "fixture-admin", password: "fixture-admin-password" });
  const session = await auth.login("fixture-admin", "fixture-admin-password");
  if (!session || !("id" in session)) throw new Error("fixture login failed");
  const journal = createSends({ db, clock, subscribers, rootUrl: () => "http://fixture.test" });
  const router = createRouter();
  registerSendRoutes(router, journal, auth);
  const app = createApp({
    bootstrap: {
      host: "127.0.0.1",
      port: 0,
      dataDir: directory,
      rootUrl: "http://fixture.test",
      initialAdmin: { user: "fixture-admin", password: "fixture-admin-password" },
    },
    db,
    clock,
    i18n: createTranslation(),
    logger: { error: () => {} },
  });
  const call = async (path: string, method = "GET", body?: string) => {
    const response = await router.handle(
      app,
      new Request(`http://fixture.test${path}`, {
        method,
        headers: {
          cookie: `session=${session.id}`,
          "x-csrf-token": session.csrf,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body }),
      }),
    );
    return { status: response.status, text: await response.text() };
  };
  return {
    journal,
    call,
    subscribers,
    roles,
    users,
    router,
    app,
    session,
    auth,
    listStore,
    clock,
    db,
    close() {
      journal.close();
      users.close();
      roles.close();
      subscribers.close();
      listStore.close();
      counts.close();
      campaigns.close();
      lists.close();
      db.close(true);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("native send journal pages and detail expose only safe metadata", async () => {
  const f = await fixture();
  try {
    const original = message();
    const a = f.journal.enqueue({ source: "tx", kind: "transactional", message: original });
    original.body.fill(0);
    const b = f.journal.enqueue({ source: "tx", kind: "marketing", message: message() });
    const page = await f.call("/api/sends?per_page=1&page=1");
    expect(page.status).toBe(200);
    const data = JSON.parse(page.text).data;
    expect(data).toMatchObject({
      total: 2,
      page: 1,
      per_page: 1,
      results: [{ id: b.id, status: "queued" }],
    });
    expect((await f.call(`/api/sends/${a.id}`)).text).not.toContain("private");
    expect(
      JSON.parse((await f.call("/api/sends?kind=transactional")).text).data.results,
    ).toHaveLength(1);
    for (const query of [
      "page=0",
      "per_page=101",
      "status=bogus",
      "subscriber_id=9223372036854775808",
    ])
      expect((await f.call(`/api/sends?${query}`)).status).toBe(400);
    expect((await f.call("/api/sends/999")).status).toBe(404);
    expect((await f.call(`/api/sends/${a.id}/resend`, "POST", "{}")).status).toBe(409);
    expect((await f.call(`/api/sends/${a.id}/resend`, "POST", '{"extra":1}')).status).toBe(400);
    for (const [body, status] of [
      ['{"secret":"do-not-reflect"}', 400],
      ["do-not-reflect{".repeat(6000), 413],
    ] as const) {
      const denied = await f.call(`/api/sends/${a.id}/resend`, "POST", body);
      expect(denied.status).toBe(status);
      expect(denied.text).not.toContain("do-not-reflect");
    }
  } finally {
    f.close();
  }
});

test("rejects malformed or oversized prepared messages atomically", async () => {
  const f = await fixture();
  try {
    expect(() =>
      f.journal.enqueue({
        source: "tx",
        kind: "transactional",
        message: { ...message(), to: ["bad\naddress"] },
      }),
    ).toThrow();
    expect(() =>
      f.journal.enqueue({
        source: "tx",
        kind: "transactional",
        message: { ...message(), body: Buffer.alloc(1024 * 1024 + 1) },
      }),
    ).toThrow();
    expect(JSON.parse((await f.call("/api/sends")).text).data.total).toBe(0);
  } finally {
    f.close();
  }
});

test("explicit resend preserves the original and returns one current child", async () => {
  const f = await fixture();
  const emailer = createEmailer({
    clock: f.clock,
    settings: () => ({ smtp: [], rootUrl: "http://fixture.test" }),
  });
  try {
    const original = f.journal.enqueue({ source: "tx", kind: "transactional", message: message() });
    const loop = startOutbox({
      db: f.db,
      clock: f.clock,
      sends: f.journal,
      emailer,
      logger: { error: () => {} },
    });
    await loop.stop();
    expect(JSON.parse((await f.call(`/api/sends/${original.id}`)).text).data.status).toBe("failed");
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => f.call(`/api/sends/${original.id}/resend`, "POST", "{}")),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const children = responses.map((r) => JSON.parse(r.text).data);
    expect(new Set(children.map((c) => c.id)).size).toBe(1);
    expect(children[0]).toMatchObject({ retry_of: original.id, status: "queued", attempts: 0 });
    expect(children[0].uuid).not.toBe(original.uuid);
    expect(children[0].smtp_message_id).not.toBe(original.smtp_message_id);
    const again = startOutbox({
      db: f.db,
      clock: f.clock,
      sends: f.journal,
      emailer,
      logger: { error: () => {} },
    });
    await again.stop();
    const repeated = JSON.parse(
      (await f.call(`/api/sends/${original.id}/resend`, "POST", "{}")).text,
    ).data;
    expect(repeated).toMatchObject({ id: children[0].id, status: "failed" });
    const grandchild = JSON.parse(
      (await f.call(`/api/sends/${children[0].id}/resend`, "POST", "{}")).text,
    ).data;
    expect(grandchild).toMatchObject({ retry_of: children[0].id, status: "queued", attempts: 0 });
    expect(grandchild.smtp_message_id).not.toBe(children[0].smtp_message_id);
    expect(grandchild.uuid).not.toBe(children[0].uuid);
    expect(JSON.parse((await f.call(`/api/sends/${original.id}`)).text).data.status).toBe("failed");
  } finally {
    await emailer.close();
    f.close();
  }
});

test("manual resend rejects each ineligible status and missing retained payload", async () => {
  const f = await fixture();
  try {
    for (const status of ["queued", "sending", "sent", "skipped", "failed", "unknown"] as const) {
      const entry = f.journal.enqueue({ source: "tx", kind: "transactional", message: message() });
      // Historical states unavailable from a producer are arranged only in this disposable fixture.
      f.db.run(
        "UPDATE sends SET status=?, payload=CASE WHEN ? IN ('failed','unknown') THEN NULL ELSE payload END WHERE id=?",
        [status, status, BigInt(entry.id as number)],
      );
      expect((await f.call(`/api/sends/${entry.id}/resend`, "POST", "{}")).status).toBe(409);
    }
    const marketing = f.journal.enqueue({ source: "tx", kind: "marketing", message: message() });
    f.db.run("UPDATE sends SET status='failed' WHERE id=?", [BigInt(marketing.id as number)]);
    expect((await f.call(`/api/sends/${marketing.id}/resend`, "POST", "{}")).status).toBe(409);
    expect(JSON.parse((await f.call("/api/sends")).text).data.total).toBe(7);
  } finally {
    f.close();
  }
});

test("an unknown child may be explicitly resent while both ancestors stay unchanged", async () => {
  const f = await fixture();
  try {
    const original = f.journal.enqueue({
      source: "tx",
      kind: "transactional",
      message: message(),
      idempotencyKey: "synthetic-original",
    });
    f.db.run("UPDATE sends SET status='unknown' WHERE id=?", [BigInt(original.id as number)]);
    const child = JSON.parse(
      (await f.call(`/api/sends/${original.id}/resend`, "POST", "{}")).text,
    ).data;
    f.db.run("UPDATE sends SET status='unknown' WHERE id=?", [BigInt(child.id)]);
    const grandchild = JSON.parse(
      (await f.call(`/api/sends/${child.id}/resend`, "POST", "{}")).text,
    ).data;
    expect(grandchild).toMatchObject({ retry_of: child.id, status: "queued", attempts: 0 });
    expect(new Set([original.uuid, child.uuid, grandchild.uuid]).size).toBe(3);
    expect(
      new Set([original.smtp_message_id, child.smtp_message_id, grandchild.smtp_message_id]).size,
    ).toBe(3);
    expect(JSON.parse((await f.call(`/api/sends/${original.id}`)).text).data.status).toBe(
      "unknown",
    );
    expect(
      JSON.parse((await f.call(`/api/sends/${original.id}/resend`, "POST", "{}")).text).data,
    ).toMatchObject({ id: child.id, status: "unknown" });
    expect(JSON.parse((await f.call(`/api/sends/${child.id}`)).text).data.status).toBe("unknown");
  } finally {
    f.close();
  }
});

test("actual TCP refusal retries only at injected-clock deadlines and stops after five attempts", async () => {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const f = await fixture();
  const emailer = createEmailer({
    clock: f.clock,
    settings: () => ({
      rootUrl: "http://fixture.test",
      smtp: [
        {
          name: "fixture",
          enabled: true,
          exclude_from_default: false,
          host: "127.0.0.1",
          port,
          hello_hostname: "fixture.test",
          max_conns: 1,
          idle_timeout: "2s",
          wait_timeout: "2s",
          auth_protocol: "none",
          username: "",
          tls_type: "none",
          tls_skip_verify: false,
          email_headers: [],
          from_addresses: [],
        },
      ],
    }),
  });
  const run = async () => {
    const outbox = startOutbox({
      db: f.db,
      clock: f.clock,
      sends: f.journal,
      emailer,
      logger: { error: () => {} },
    });
    await outbox.stop();
  };
  try {
    const entry = f.journal.enqueue({ source: "tx", kind: "transactional", message: message() });
    for (let attempt = 1; attempt <= 5; attempt++) {
      await run();
      let row = JSON.parse((await f.call(`/api/sends/${entry.id}`)).text).data;
      expect(row.attempts).toBe(attempt);
      expect(row.smtp_message_id).toBe(entry.smtp_message_id);
      if (attempt === 5) {
        expect(row.status).toBe("failed");
        break;
      }
      expect(row.status).toBe("queued");
      f.clock.advance(1000 * 2 ** (attempt - 1) - 1);
      await run();
      row = JSON.parse((await f.call(`/api/sends/${entry.id}`)).text).data;
      expect(row.attempts).toBe(attempt);
      f.clock.advance(1);
    }
  } finally {
    await emailer.close();
    f.close();
  }
});

test("linked identity changes and unavailable marketing policy fail closed at dispatch", async () => {
  const f = await fixture();
  const emailer = createEmailer({
    clock: f.clock,
    settings: () => ({ smtp: [], rootUrl: "http://fixture.test" }),
  });
  const run = async () => {
    const loop = startOutbox({
      db: f.db,
      clock: f.clock,
      sends: f.journal,
      emailer,
      logger: { error: () => {} },
    });
    await loop.stop();
  };
  try {
    const scope = { all: true, ids: [] };
    const subscriber = f.subscribers.create(
      { email: "recipient@example.test", name: "Fixture" },
      scope,
    );
    const blocked = f.journal.enqueue({
      source: "tx",
      kind: "transactional",
      message: message(),
      subscriberId: subscriber.id,
    });
    f.subscribers.blocklist([subscriber.id]);
    await run();
    expect(JSON.parse((await f.call(`/api/sends/${blocked.id}`)).text).data).toMatchObject({
      status: "skipped",
      skip_reason: "subscriber_blocklisted",
    });
    f.subscribers.update(f.subscribers.get(subscriber.id)!, { status: "enabled" }, true, scope);
    const changed = f.journal.enqueue({
      source: "tx",
      kind: "transactional",
      message: message(),
      subscriberId: subscriber.id,
    });
    f.subscribers.update(
      f.subscribers.get(subscriber.id)!,
      { email: "new@example.test" },
      true,
      scope,
    );
    await run();
    expect(JSON.parse((await f.call(`/api/sends/${changed.id}`)).text).data).toMatchObject({
      status: "skipped",
      skip_reason: "subscriber_unavailable",
    });
    f.subscribers.update(
      f.subscribers.get(subscriber.id)!,
      { email: "recipient@example.test" },
      true,
      scope,
    );
    const deleted = f.journal.enqueue({
      source: "tx",
      kind: "transactional",
      message: message(),
      subscriberId: subscriber.id,
    });
    f.subscribers.remove([subscriber.id]);
    f.subscribers.create({ email: "recipient@example.test", name: "Replacement" }, scope);
    await run();
    expect(JSON.parse((await f.call(`/api/sends/${deleted.id}`)).text).data).toMatchObject({
      status: "skipped",
      skip_reason: "subscriber_unavailable",
      subscriber_id: null,
    });
    const marketing = f.journal.enqueue({ source: "tx", kind: "marketing", message: message() });
    await run();
    expect(JSON.parse((await f.call(`/api/sends/${marketing.id}`)).text).data).toMatchObject({
      status: "skipped",
      skip_reason: "policy_unavailable",
    });
  } finally {
    await emailer.close();
    f.close();
  }
});

test("owned enqueue wakes an idle outbox without advancing its polling clock", async () => {
  const f = await fixture();
  const emailer = createEmailer({
    clock: f.clock,
    settings: () => ({ smtp: [], rootUrl: "http://fixture.test" }),
  });
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const sends = {
    ...f.journal,
    finish(
      row: Parameters<typeof f.journal.finish>[0],
      outcome: Parameters<typeof f.journal.finish>[1],
    ) {
      f.journal.finish(row, outcome);
      finished();
    },
  };
  const outbox = startOutbox({
    db: f.db,
    clock: f.clock,
    sends,
    emailer,
    logger: { error: () => {} },
  });
  try {
    await f.clock.whenSleeping();
    const entry = f.journal.enqueue({ source: "tx", kind: "transactional", message: message() });
    await done;
    expect(JSON.parse((await f.call(`/api/sends/${entry.id}`)).text).data.status).toBe("failed");
  } finally {
    await outbox.stop();
    await emailer.close();
    f.close();
  }
});

test("permissions and live authority are rechecked after the resend body is drained", async () => {
  const f = await fixture();
  const emailer = createEmailer({
    clock: f.clock,
    settings: () => ({ smtp: [], rootUrl: "http://fixture.test" }),
  });
  try {
    const original = f.journal.enqueue({ source: "tx", kind: "transactional", message: message() });
    const outbox = startOutbox({
      db: f.db,
      clock: f.clock,
      sends: f.journal,
      emailer,
      logger: { error: () => {} },
    });
    await outbox.stop();
    const role = f.roles.mutate(
      "user",
      null,
      "send-fixture",
      ["sends:get", "sends:manage"],
      [],
      f.clock.now().toISOString(),
    )!;
    const token = "synthetic-send-token";
    f.users.create({
      username: "send-fixture",
      email: "fixture@example.test",
      name: "Fixture",
      type: "api",
      status: "enabled",
      passwordLogin: false,
      password: createHash("sha256").update(token).digest("hex"),
      userRoleId: role,
      listRoleId: null,
    });
    const header = `token send-fixture:${token}`;
    const headers = { authorization: header, "content-type": "application/json" };
    const request = (path: string, init: RequestInit) =>
      f.router.handle(f.app, new Request(`http://fixture.test${path}`, init));
    expect((await request("/api/sends", { headers })).status).toBe(200);
    expect(
      (
        await request("/api/sends", {
          headers: { authorization: "token invalid:invalid", cookie: `session=${f.session.id}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/sends/${original.id}/resend`, {
          method: "POST",
          headers: {
            cookie: `session=${f.session.id}`,
            origin: "http://other.test",
            "x-csrf-token": f.session.csrf,
          },
          body: "",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/sends/${original.id}/resend`, {
          method: "POST",
          headers: { cookie: `session=${f.session.id}` },
          body: "",
        })
      ).status,
    ).toBe(403);
    let entered!: () => void, release!: () => void;
    const read = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(new TextEncoder().encode("{"));
          entered();
        } else {
          await gate;
          controller.enqueue(new TextEncoder().encode("}"));
          controller.close();
        }
      },
    });
    const pending = request(`/api/sends/${original.id}/resend`, { method: "POST", headers, body });
    await read;
    f.roles.mutate("user", role, "send-fixture", ["sends:get"], [], f.clock.now().toISOString());
    release();
    expect((await pending).status).toBe(403);
    const collection = JSON.parse((await f.call("/api/sends")).text).data;
    expect(collection.total).toBe(1);
    expect(
      (await request(`/api/sends/${original.id}/resend`, { method: "POST", headers, body: "{}" }))
        .status,
    ).toBe(403);
  } finally {
    await emailer.close();
    f.close();
  }
});

test("prepared payload limits are enforced atomically at the owner and safe HTTP boundary", async () => {
  const f = await fixture();
  const enqueue = (m: Message) =>
    f.journal.enqueue({ source: "tx", kind: "transactional", message: m });
  try {
    const mib = 1024 * 1024;
    const exactBody = { ...message(), body: Buffer.alloc(mib), altBody: Buffer.alloc(mib) };
    enqueue(exactBody);
    const attachments = Array.from({ length: 10 }, (_, i) => ({
      name: `binary-${i}.bin`,
      content: Buffer.alloc(i === 0 ? 4 * mib - 9 : 1, i),
      contentType: "application/octet-stream",
    }));
    enqueue({ ...message(), attachments });
    const headers = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`X-Test-${i}`, "é".repeat(1024)]),
    );
    enqueue({ ...message(), headers });
    const invalid = [
      { ...message(), body: Buffer.alloc(mib + 1) },
      { ...message(), altBody: Buffer.alloc(mib + 1) },
      { ...message(), attachments: [...attachments, { name: "extra", content: Buffer.alloc(0) }] },
      { ...message(), attachments: [{ name: "large", content: Buffer.alloc(4 * mib + 1) }] },
      {
        ...message(),
        attachments: [
          { name: "first", content: Buffer.alloc(4 * mib) },
          { name: "second", content: Buffer.alloc(1) },
        ],
      },
      { ...message(), headers: { ...headers, "X-Extra": "x" } },
      { ...message(), headers: { "X-Test": `${"é".repeat(1024)}x` } },
      { ...message(), headers: { "bad name": "x" } },
      { ...message(), headers: { "X-Test": "secret\r\ninjected" } },
      { ...message(), from: "invalid address" },
      { ...message(), to: ["recipient@example.test\nBcc: secret@example.test"] },
      { ...message(), contentType: "invalid" },
      {
        ...message(),
        attachments: [{ name: "file", content: Buffer.from([0]), contentType: "not-a-media-type" }],
      },
      {
        ...message(),
        attachments: [
          { name: "file", content: Buffer.from([0]), contentType: "text/plain\r\nX-Secret: x" },
        ],
      },
    ];
    for (const input of invalid)
      expect(() => enqueue(input as Message)).toThrow("Invalid prepared message");
    const response = await f.call("/api/sends?per_page=100");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).data.total).toBe(3);
    expect(response.text).not.toContain("private");
  } finally {
    f.close();
  }
});

test("encoded payload boundary accepts exactly eight MiB and rejects one byte more", async () => {
  const f = await fixture();
  try {
    const mib = 1024 * 1024;
    const m = {
      ...message(),
      body: Buffer.alloc(mib),
      altBody: Buffer.alloc(mib),
      attachments: [{ name: "bytes", content: Buffer.alloc(4 * mib - 2048) }],
      headers: { "X-Pad-A": "", "X-Pad-B": "" },
    };
    // Construct the documented versioned representation to choose data exactly at the byte limit.
    const encoded = JSON.stringify({
      version: 1,
      subscriberUuid: null,
      message: {
        from: m.from,
        to: m.to,
        subject: m.subject,
        contentType: m.contentType,
        body: m.body.toString("base64"),
        altBody: m.altBody.toString("base64"),
        headers: m.headers,
        attachments: m.attachments.map((a) => ({
          name: a.name,
          content: a.content.toString("base64"),
        })),
      },
    });
    const padding = 8 * mib - Buffer.byteLength(encoded);
    expect(padding).toBeGreaterThan(2048);
    expect(padding).toBeLessThanOrEqual(4095);
    m.headers["X-Pad-A"] = "x".repeat(2048);
    m.headers["X-Pad-B"] = "x".repeat(padding - 2048);
    f.journal.enqueue({ source: "tx", kind: "transactional", message: m });
    m.headers["X-Pad-B"] += "x";
    expect(() => f.journal.enqueue({ source: "tx", kind: "transactional", message: m })).toThrow(
      "Invalid prepared message",
    );
    expect(JSON.parse((await f.call("/api/sends")).text).data.total).toBe(1);
  } finally {
    f.close();
  }
});

test("high automatic journal IDs retain exact JSON, path, filters and overflow behavior", async () => {
  const f = await fixture();
  try {
    // Set only disposable historical high-water state; subsequent IDs are allocated normally.
    f.db.run("INSERT INTO sqlite_sequence(name, seq) VALUES ('sends', ?) ON CONFLICT DO NOTHING", [
      9007199254740992n,
    ]);
    f.db.run("UPDATE sqlite_sequence SET seq=? WHERE name='sends'", [9007199254740992n]);
    f.journal.enqueue({ source: "tx", kind: "transactional", message: message() });
    f.journal.enqueue({ source: "tx", kind: "transactional", message: message() });
    const collection = await f.call("/api/sends?status=queued&source=tx&kind=transactional");
    expect(collection.text).toContain('"id":9007199254740994');
    expect(collection.text).toContain('"id":9007199254740993');
    expect((await f.call("/api/sends/9007199254740993")).text).toContain('"id":9007199254740993');
    expect((await f.call("/api/sends/9223372036854775808")).status).toBe(400);
    expect((await f.call("/api/sends?list_id=9223372036854775808")).status).toBe(400);
    expect(
      JSON.parse((await f.call("/api/sends?subscriber_id=9007199254740993")).text).data.total,
    ).toBe(0);
    f.db.run("INSERT INTO sqlite_sequence(name, seq) VALUES ('lists', ?)", [9007199254740992n]);
    const highList = f.listStore.create({
      name: "high list",
      type: "private",
      optin: "single",
      status: "active",
      tags: [],
      description: null,
    });
    f.journal.enqueue({
      source: "tx",
      kind: "transactional",
      message: message(),
      listId: 9007199254740993n,
    });
    const listFiltered = await f.call("/api/sends?list_id=9007199254740993");
    expect(listFiltered.text).toContain('"list_id":9007199254740993');
    expect(listFiltered.text).toContain('"id":9007199254740995');
    f.listStore.remove(
      [9007199254740993n],
      { query: "", type: "", optin: "", status: "", tags: [] },
      { all: true, ids: [] },
    );
    expect((await f.call("/api/sends/9007199254740995")).text).toContain('"list_id":null');
    expect(JSON.stringify(highList)).toContain('"id":9007199254740993');
    f.db.run("INSERT INTO sqlite_sequence(name, seq) VALUES ('subscribers', ?)", [
      9007199254740992n,
    ]);
    const subscriber = f.subscribers.create(
      { email: "recipient@example.test", name: "High ID" },
      { all: true, ids: [] },
    );
    expect(subscriber.id).toBe(9007199254740993n);
    f.journal.enqueue({
      source: "tx",
      kind: "transactional",
      message: message(),
      subscriberId: subscriber.id,
    });
    const filtered = await f.call("/api/sends?subscriber_id=9007199254740993");
    expect(filtered.text).toContain('"subscriber_id":9007199254740993');
    expect(filtered.text).toContain('"id":9007199254740996');
    f.subscribers.remove([subscriber.id]);
    const deleted = await f.call("/api/sends/9007199254740996");
    expect(deleted.text).toContain('"subscriber_id":null');
    expect(
      JSON.parse((await f.call("/api/sends?subscriber_id=9007199254740993")).text).data.total,
    ).toBe(0);
  } finally {
    f.close();
  }
});

test("automatic allocation reaches signed 64-bit maximum and fails atomically beyond it", async () => {
  const f = await fixture();
  try {
    f.db.run("INSERT INTO sqlite_sequence(name, seq) VALUES ('sends', ?)", [9223372036854775806n]);
    f.journal.enqueue({ source: "tx", kind: "transactional", message: message() });
    expect((await f.call("/api/sends/9223372036854775807")).text).toContain(
      '"id":9223372036854775807',
    );
    expect(() =>
      f.journal.enqueue({ source: "tx", kind: "transactional", message: message() }),
    ).toThrow();
    expect(JSON.parse((await f.call("/api/sends")).text).data.total).toBe(1);
  } finally {
    f.close();
  }
});

test("live resend authority rejects disabled, deleted and revoked principals while body is held", async () => {
  const f = await fixture();
  try {
    const original = f.journal.enqueue({ source: "tx", kind: "transactional", message: message() });
    f.db.run("UPDATE sends SET status='failed' WHERE id=?", [BigInt(original.id as number)]);
    const role = f.roles.mutate(
      "user",
      null,
      "live-send",
      ["sends:get", "sends:manage"],
      [],
      f.clock.now().toISOString(),
    )!;
    const readOnlyRole = f.roles.mutate(
      "user",
      null,
      "read-send",
      ["sends:get"],
      [],
      f.clock.now().toISOString(),
    )!;
    const otherRole = f.roles.mutate(
      "user",
      null,
      "tx-only",
      ["tx:send"],
      [],
      f.clock.now().toISOString(),
    )!;
    const list = f.listStore.create({
      name: "send fixture",
      type: "private",
      optin: "single",
      status: "active",
      tags: [],
      description: null,
    });
    const linked = f.subscribers.create(
      { email: "recipient@example.test", name: "Linked" },
      { all: true, ids: [] },
    );
    f.journal.enqueue({
      source: "tx",
      kind: "transactional",
      message: message(),
      subscriberId: linked.id,
      listId: BigInt(list.id as number),
    });
    const listRole = f.roles.mutate(
      "list",
      null,
      "send-list",
      [],
      [{ id: BigInt(list.id as number), permissions: ["list:get", "list:manage"] }],
      f.clock.now().toISOString(),
    )!;
    const token = "synthetic-live-token";
    const makeApi = (name: string, userRoleId: bigint, listRoleId: bigint | null = null) =>
      f.users.create({
        username: name,
        email: `${name}@example.test`,
        name: "Fixture",
        type: "api",
        status: "enabled",
        passwordLogin: false,
        password: createHash("sha256").update(token).digest("hex"),
        userRoleId,
        listRoleId,
      });
    const disabled = makeApi("disabled-send", role);
    const deleted = makeApi("deleted-send", role);
    makeApi("read-send", readOnlyRole);
    makeApi("tx-send", otherRole, listRole);
    const request = (path: string, init: RequestInit) =>
      f.router.handle(f.app, new Request(`http://fixture.test${path}`, init));
    const apiHeaders = (name: string) => ({
      authorization: `token ${name}:${token}`,
      "content-type": "application/json",
    });
    const globalRead = await request("/api/sends", { headers: apiHeaders("read-send") });
    expect(globalRead.status).toBe(200);
    expect((await globalRead.json()).data.total).toBe(2);
    expect(
      (
        await request(`/api/sends/${original.id}/resend`, {
          method: "POST",
          headers: apiHeaders("read-send"),
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect((await request("/api/sends", { headers: apiHeaders("tx-send") })).status).toBe(403);
    expect(
      (
        await request(`/api/sends/${original.id}/resend`, {
          method: "POST",
          headers: apiHeaders("tx-send"),
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const held = async (headers: Record<string, string>, mutate: () => void) => {
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((ok) => {
        entered = ok;
      });
      const gate = new Promise<void>((ok) => {
        release = ok;
      });
      let first = true;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (first) {
            first = false;
            controller.enqueue(new TextEncoder().encode("{"));
            entered();
          } else {
            await gate;
            controller.enqueue(new TextEncoder().encode("}"));
            controller.close();
          }
        },
      });
      const pending = request(`/api/sends/${original.id}/resend`, {
        method: "POST",
        headers,
        body,
      });
      await ready;
      mutate();
      release();
      expect((await pending).status).toBe(403);
      expect(JSON.parse((await f.call("/api/sends")).text).data.total).toBe(2);
    };
    await held(apiHeaders("disabled-send"), () => {
      f.users.update(disabled.id, (u) => ({
        username: u.username,
        passwordLogin: false,
        password: u.password,
        email: u.email,
        name: u.name,
        type: u.type,
        userRoleId: u.user_role_id,
        listRoleId: u.list_role_id,
        status: "disabled",
      }));
    });
    await held(apiHeaders("deleted-send"), () => {
      f.users.delete([deleted.id]);
    });
    const human = f.users.create({
      username: "human-send",
      email: "human@example.test",
      name: "Human",
      type: "user",
      status: "enabled",
      passwordLogin: true,
      password: await Bun.password.hash("synthetic-human-password"),
      userRoleId: role,
      listRoleId: null,
    });
    const login = await f.auth.login("human-send", "synthetic-human-password");
    if (!login || !("id" in login)) throw new Error("fixture login failed");
    await held(
      {
        cookie: `session=${login.id}`,
        "x-csrf-token": login.csrf,
        "content-type": "application/json",
      },
      () => {
        f.users.deleteSession(login.id);
      },
    );
    expect(f.users.byId(human.id)).not.toBeNull();
  } finally {
    f.close();
  }
});

test("the outbox claims the lowest queued id that is new or due for retry (D24)", async () => {
  const f = await fixture();
  try {
    const enqueue = () =>
      Number(f.journal.enqueue({ source: "tx", kind: "transactional", message: message() }).id);
    const claim = () => {
      const now = f.clock.now();
      return f.journal.claim(now, new Date(now.getTime() + 60_000)).map((row) => Number(row.id));
    };
    const [a, b, c] = [enqueue(), enqueue(), enqueue()];
    const [first] = f.journal.claim(f.clock.now(), new Date(f.clock.now().getTime() + 60_000));
    expect(Number(first!.id)).toEqual(a);
    f.journal.finish(first!, {
      messageId: first!.smtp_message_id!,
      status: "proven-not-accepted",
      stage: "setup",
      accepted: [],
      rejected: [],
      retry: "transient",
    });
    // The retry waits one second; the next new row goes first meanwhile.
    expect(claim()).toEqual([b]);
    f.clock.advance(999);
    expect(claim()).toEqual([c]);
    // A newer row is still queued when the retry falls due: the lower-id retry goes first.
    const d = enqueue();
    f.clock.advance(1);
    expect(claim()).toEqual([a]);
    expect(claim()).toEqual([d]);
    expect(claim()).toEqual([]);
  } finally {
    f.close();
  }
});
