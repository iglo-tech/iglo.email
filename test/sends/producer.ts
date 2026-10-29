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

const directory = process.env.SENDS_FIXTURE_DIR!;
const port = Number(process.env.SENDS_FIXTURE_SMTP_PORT);
const useAuth = process.env.SENDS_FIXTURE_AUTH === "1";
if (!directory || !Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid fixture configuration");
const clock = new TestClock(),
  db = openDatabase(directory);
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
  marketingPolicy: () => true,
});
const emailer = createEmailer({
  clock,
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
        auth_protocol: useAuth ? "plain" : "none",
        username: useAuth ? "fixture-user" : "",
        ...(useAuth ? { password: "fixture-password" } : {}),
        tls_type: "none",
        tls_skip_verify: false,
        email_headers: [],
        from_addresses: [],
      },
    ],
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
  };
  return ok(
    sends.enqueue({
      source: "tx",
      kind: input.kind,
      message: {
        from: "sender@example.test",
        to: ["recipient@example.test"],
        subject: input.subject,
        contentType: "plain",
        body: Buffer.from("synthetic crash fixture"),
        ...(input.cc ? { headers: { Cc: input.cc } } : {}),
      },
    }),
  );
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
router.route("POST", "/fixture/clock", async ({ request }) => {
  clock.advance(Number(await request.text()));
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
