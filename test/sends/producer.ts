// Test-only compiled producer and barriers; never part of the production executable.
import { createApp } from "@/app";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { createSubscriberStore } from "@/subscribers/store";
import { createRoles } from "@/roles/roles";
import { createUserStore } from "@/users/store";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { createRouter } from "@/server/server";
import { ok } from "@/server/response";
import { createEmailer } from "@/messaging/email";
import { createSends } from "@/messaging/sends";
import { startOutbox } from "@/messaging/outbox";
import { registerSendRoutes } from "@/messaging/routes";
import { TestClock } from "@/test/server/fixture";
import { createSettings } from "@/settings/store";
import { createHash } from "node:crypto";

const directory = process.env.SENDS_FIXTURE_DIR!;
const port = Number(process.env.SENDS_FIXTURE_SMTP_PORT);
const useAuth = process.env.SENDS_FIXTURE_AUTH === "1";
if (!directory || !Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid fixture configuration");
const clock = new TestClock(),
  db = openDatabase(directory);
clock.advance(Number(process.env.SENDS_FIXTURE_CLOCK_OFFSET ?? "0"));
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
const admin = { user: "fixture-admin", password: "fixture-admin-password" };
await bootstrapAdmin(users, auth, admin);
const login = await auth.login(admin.user, admin.password);
if (!login || !("id" in login)) throw new Error("Fixture authentication failed");
const app = createApp({
  bootstrap: {
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    rootUrl: "http://fixture.test",
    initialAdmin: admin,
  },
  db,
  clock,
  i18n: createTranslation(),
  logger: { error: () => {} },
});
const sends = createSends({
  db,
  clock,
  subscribers,
  rootUrl: () => "http://fixture.test",
  // Component evidence only: consent always granted and the cap disabled.
  marketingPolicy: { consent: () => null, capStart: () => null },
});
const settings = createSettings(db, clock, "http://fixture.test", roles);
const smtp = {
  name: "fixture",
  enabled: true,
  exclude_from_default: false,
  host: "127.0.0.1",
  port,
  hello_hostname: "fixture.test",
  max_conns: 1,
  idle_timeout: "2s",
  wait_timeout: "2s",
  max_msg_retries: 0,
  msg_retry_delay: "1s",
  auth_protocol: useAuth ? "plain" : "none",
  username: useAuth ? "fixture-user" : "",
  password: useAuth ? "fixture-password" : "",
  tls_type: "none",
  tls_skip_verify: false,
  email_headers: [{ "Message-ID": "<server@example.test>" }],
  from_addresses: [],
};
const emailer = createEmailer({
  clock,
  settings: () => ({
    rootUrl: "http://fixture.test",
    smtp: [smtp],
  }),
});
let announce!: () => void;
const entered = new Promise<void>((resolve) => {
  announce = resolve;
});
let finishedCount = 0;
const waiters: Array<() => void> = [];
let finish!: () => void;
const committed = new Promise<void>((resolve) => {
  finish = resolve;
});
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
let loop: ReturnType<typeof startOutbox> | undefined;
const router = createRouter();
registerSendRoutes(router, sends, auth);
router.route("POST", "/fixture/enqueue", async ({ request }) => {
  const input = (await request.json()) as {
    subject: string;
    kind: "marketing" | "transactional";
    cc?: string;
    mutation?: boolean;
    large?: boolean;
    alternate?: boolean;
  };
  const body = input.large
    ? Buffer.alloc(1024 * 1024, 65)
    : Buffer.from(
        input.alternate
          ? "<p>synthetic alternate</p>"
          : input.mutation
            ? "original UTF-8: zażółć"
            : "synthetic crash fixture",
      );
  const altBody = input.alternate ? Buffer.alloc(1024 * 1024, 66) : undefined;
  const attachment = Buffer.from([0, 1, 2, 13, 10, 127, 128, 255]);
  const largeAttachments = input.large
    ? Array.from({ length: 10 }, (_, i) => ({
        name: `part-${i}.bin`,
        content: Buffer.alloc(i === 0 ? 4 * 1024 * 1024 - 9 : 1, i === 0 ? 0xa5 : i),
        contentType: "application/octet-stream",
      }))
    : [];
  const headers = {
    "Message-ID": "<caller-header@example.test>",
    "X-Fixture": "original",
    ...(input.cc ? { Cc: input.cc } : {}),
  };
  const to = ["recipient@example.test"];
  const entry = sends.enqueue({
    source: "tx",
    kind: input.kind,
    message: {
      from: "sender@example.test",
      to,
      subject: input.subject,
      contentType: input.alternate ? "html" : "plain",
      body,
      ...(altBody ? { altBody } : {}),
      headers,
      messageId: "<caller@example.test>",
      ...(input.mutation
        ? {
            attachments: [
              { name: "binary.bin", content: attachment, contentType: "application/octet-stream" },
            ],
          }
        : input.large
          ? { attachments: largeAttachments }
          : {}),
    },
  });
  body.fill(0);
  altBody?.fill(0);
  attachment.fill(0);
  for (const part of largeAttachments) part.content.fill(0);
  headers["X-Fixture"] = "mutated";
  to[0] = "changed@example.test";
  return ok(entry);
});
router.route("POST", "/fixture/settings", () => {
  settings.update((current) => ({ ...current, smtp: [smtp] }));
  return ok(true);
});
router.route("POST", "/fixture/start", async ({ request }) => {
  const mode = await request.text();
  if (loop) throw new Error("already started");
  const wrapped = {
    ...emailer,
    push(message: Parameters<typeof emailer.push>[0]) {
      if (mode === "before-smtp") {
        announce();
        return {
          messageId: message.messageId!,
          result: gate.then(() => emailer.push(message).result),
        };
      }
      const dispatch = emailer.push(message);
      if (mode === "after-ack")
        return {
          ...dispatch,
          result: dispatch.result.then(async (result) => {
            announce();
            await gate;
            return result;
          }),
        };
      return dispatch;
    },
  };
  const tracked = {
    ...sends,
    finish(row: Parameters<typeof sends.finish>[0], outcome: Parameters<typeof sends.finish>[1]) {
      sends.finish(row, outcome);
      finishedCount++;
      for (const notify of waiters.splice(0)) notify();
      finish();
    },
  };
  loop = startOutbox({ db, clock, sends: tracked, emailer: wrapped, logger: app.logger });
  return ok(true);
});
router.route("GET", "/fixture/entered", async () => {
  await entered;
  return ok(true);
});
router.route("GET", "/fixture/committed", async () => {
  await committed;
  return ok(true);
});
router.route("GET", "/fixture/finished", async (context) => {
  const count = Number(context.url.searchParams.get("count"));
  while (finishedCount < count) await new Promise<void>((resolve) => waiters.push(resolve));
  return ok(finishedCount);
});
router.route("GET", "/fixture/session", () =>
  ok({ cookie: `session=${login.id}`, csrf: login.csrf }),
);
router.route("POST", "/fixture/authority", async ({ request }) => {
  const input = (await request.json()) as { id: number };
  const role = roles.mutate(
    "user",
    null,
    "fixture-live-send",
    ["sends:get", "sends:manage"],
    [],
    clock.now().toISOString(),
  )!;
  const token = "synthetic-live-token";
  const makeApi = (name: string) =>
    users.create({
      username: name,
      email: `${name}@example.test`,
      name: "Fixture",
      type: "api",
      status: "enabled",
      passwordLogin: false,
      password: createHash("sha256").update(token).digest("hex"),
      userRoleId: role,
      listRoleId: null,
    });
  const disabled = makeApi("fixture-disabled"),
    deleted = makeApi("fixture-deleted");
  makeApi("fixture-revoked");
  users.create({
    username: "fixture-human",
    email: "fixture-human@example.test",
    name: "Fixture",
    type: "user",
    status: "enabled",
    passwordLogin: true,
    password: await Bun.password.hash("synthetic-human-password"),
    userRoleId: role,
    listRoleId: null,
  });
  const human = await auth.login("fixture-human", "synthetic-human-password");
  if (!human || !("id" in human)) throw new Error("Fixture login failed");
  const held = async (headers: Record<string, string>, mutate: () => void) => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
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
    const pending = router.handle(
      app,
      new Request(`http://fixture.test/api/sends/${input.id}/resend`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
      }),
    );
    await ready;
    mutate();
    release();
    return (await pending).status;
  };
  const api = (name: string) => ({ authorization: `token ${name}:${token}` });
  const statuses = [
    await held(api("fixture-disabled"), () => {
      users.update(disabled.id, (u) => ({
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
    }),
    await held(api("fixture-deleted"), () => {
      users.delete([deleted.id]);
    }),
    await held({ cookie: `session=${human.id}`, "x-csrf-token": human.csrf }, () => {
      users.deleteSession(human.id);
    }),
    await held(api("fixture-revoked"), () => {
      roles.mutate("user", role, "fixture-live-send", ["sends:get"], [], clock.now().toISOString());
    }),
  ];
  for (const headers of [
    { cookie: `session=${login.id}` },
    { cookie: `session=${login.id}`, "x-csrf-token": login.csrf, origin: "http://other.test" },
    {
      cookie: `session=${login.id}`,
      "x-csrf-token": login.csrf,
      authorization: "token invalid:invalid",
    },
  ]) {
    statuses.push(
      (
        await router.handle(
          app,
          new Request(`http://fixture.test/api/sends/${input.id}/resend`, {
            method: "POST",
            headers,
            body: "",
          }),
        )
      ).status,
    );
  }
  return ok(statuses);
});
router.route("POST", "/fixture/failed", async ({ request }) => {
  const input = (await request.json()) as { id: number };
  // Arrange a historical terminal state in this test-only database.
  db.run("UPDATE sends SET status='failed' WHERE id=?", [BigInt(input.id)]);
  return ok(true);
});
router.route("POST", "/fixture/invalid", () => {
  const failures: string[] = [];
  for (const message of [
    {
      from: "sender@example.test",
      to: ["bad\nsecret@example.test"],
      subject: "secret-value",
      contentType: "plain" as const,
      body: Buffer.from("secret"),
    },
    {
      from: "sender@example.test",
      to: ["recipient@example.test"],
      subject: "secret-value",
      contentType: "plain" as const,
      body: Buffer.alloc(1024 * 1024 + 1),
    },
  ]) {
    try {
      sends.enqueue({ source: "tx", kind: "transactional", message });
      failures.push("unexpected success");
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "error");
    }
  }
  return ok(failures);
});
router.route("POST", "/fixture/clock", async ({ request }) => {
  clock.advance(Number(await request.text()));
  return ok(true);
});
router.route("GET", "/fixture/idle", async () => {
  await clock.whenSleeping();
  return ok(true);
});
router.route("POST", "/fixture/release", () => {
  release();
  return ok(true);
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => router.handle(app, request),
});
process.stdout.write(`${server.port}\n`);
