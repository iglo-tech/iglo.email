import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { createSubscriberStore } from "@/subscribers/store";
import { createRoles } from "@/roles/roles";
import { createRouter } from "@/server/server";
import { TestClock } from "@/test/server/fixture";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { createUserStore } from "@/users/store";
import { createEmailer } from "@/messaging/email";
import { startOutbox } from "@/messaging/outbox";
import { createServer } from "node:net";
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
    clock,
    db,
    close() {
      journal.close();
      users.close();
      roles.close();
      subscribers.close();
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
    expect(JSON.parse((await f.call(`/api/sends/${original.id}`)).text).data.status).toBe("failed");
  } finally {
    await emailer.close();
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
