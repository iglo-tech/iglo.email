// B35 (D89): Amazon SES is the only provider.
// Public boundary tests for Mailgun removal, migration, existing history, and UI.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createRouter } from "@/server/server";
import { createSettings } from "@/settings/store";
import { registerSettingsRoutes } from "@/settings/routes";
import { createRoles } from "@/roles/roles";
import { createListReferences } from "@/lists/references";
import { createUserStore } from "@/users/store";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { settingsView } from "@/admin/views/settings";
import { render } from "@/jsx/render";
import { buildDocument } from "@/openapi/document";
import { TestClock } from "@/test/server/fixture";
import { txFixture } from "@/test/tx/fixture";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

test("1. POST /webhooks/bounce/mailgun answers the same as an unknown route (404)", async () => {
  const f = await txFixture({ webhooks: {} });
  cleanups.push(() => f.close());

  const unknown = await f.request("/some-unknown-path", { method: "POST" });
  const mailgun = await f.request("/webhooks/bounce/mailgun", { method: "POST" });

  expect(mailgun.status).toBe(unknown.status);
  expect(mailgun.status).toBe(404);
});

test("2. Upgraded database drops stored bounce.mailgun row, GET /api/settings omits it, and PUT round-trips", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "b35-upgrade-test-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const clock = new TestClock();
  const rawDb = openDatabase(dataDir);

  // Run migrations up to 18 (before B35)
  runMigrations(rawDb, dataDir, clock, productionMigrations.slice(0, 18));

  // Insert a stored bounce.mailgun row with a secret key
  rawDb.run(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (\'bounce.mailgun\', \'{"enabled": true, "key": "super-secret-mailgun-key"}\')',
  );
  expect(
    rawDb.query("SELECT key, value FROM settings WHERE key = 'bounce.mailgun'").get(),
  ).toBeDefined();

  // Now run all current migrations (including forward migration 19)
  runMigrations(rawDb, dataDir, clock, productionMigrations);

  // The stored row must be deleted by migration
  const storedRow = rawDb.query("SELECT key FROM settings WHERE key = 'bounce.mailgun'").get();
  expect(storedRow).toBeNull();
  rawDb.close(true);

  // Boot the app with the upgraded database and test GET/PUT /api/settings
  const db = openDatabase(dataDir);
  cleanups.push(() => db.close(true));
  const lists = createListReferences(db);
  const roles = createRoles(db, lists);
  const users = createUserStore(db, clock, roles);
  const settings = createSettings(db, clock, "http://fixture.test", roles);
  const auth = await createAuthentication(
    users,
    roles,
    clock,
    "http://fixture.test",
    defaultAuthPolicy,
  );
  await bootstrapAdmin(users, auth, { user: "admin", password: "admin-password" });
  const session = await auth.login("admin", "admin-password");
  if (!session || !("id" in session)) throw new Error("login failed");

  const app = createApp({
    bootstrap: {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      rootUrl: "http://fixture.test",
      initialAdmin: { user: "admin", password: "admin-password" },
    },
    db,
    clock,
    i18n: createTranslation(),
    logger: { error() {} },
  });
  const router = createRouter();
  registerSettingsRoutes(router, settings, auth);

  const getRes = await router.handle(
    app,
    new Request("http://fixture.test/api/settings", {
      headers: { cookie: `session=${session.id}` },
    }),
  );
  expect(getRes.status).toBe(200);
  const body = (await getRes.json()) as { data: Record<string, unknown> };
  expect(body.data["bounce.mailgun"]).toBeUndefined();

  // PUT round-trip succeeds
  const putRes = await router.handle(
    app,
    new Request("http://fixture.test/api/settings", {
      method: "PUT",
      headers: {
        cookie: `session=${session.id}`,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify(body.data),
    }),
  );
  expect(putRes.status).toBe(200);

  // Old client sending bounce.mailgun in a full PUT returns 200, a following GET has no bounce.mailgun, and nothing is stored
  const putWithOldKey = await router.handle(
    app,
    new Request("http://fixture.test/api/settings", {
      method: "PUT",
      headers: {
        cookie: `session=${session.id}`,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...body.data,
        "bounce.mailgun": { enabled: true, key: "x" },
      }),
    }),
  );
  expect(putWithOldKey.status).toBe(200);

  const getAfterPut = await router.handle(
    app,
    new Request("http://fixture.test/api/settings", {
      headers: { cookie: `session=${session.id}` },
    }),
  );
  expect(getAfterPut.status).toBe(200);
  const bodyAfterPut = (await getAfterPut.json()) as { data: Record<string, unknown> };
  expect(bodyAfterPut.data["bounce.mailgun"]).toBeUndefined();
  expect(db.query("SELECT key FROM settings WHERE key = 'bounce.mailgun'").get()).toBeNull();

  // Single-key PUT /api/settings/bounce.mailgun returns 400
  const putSingleKey = await router.handle(
    app,
    new Request("http://fixture.test/api/settings/bounce.mailgun", {
      method: "PUT",
      headers: {
        cookie: `session=${session.id}`,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ enabled: true, key: "x" }),
    }),
  );
  expect(putSingleKey.status).toBe(400);
});

test("3. Existing source='mailgun' bounce row still shows in GET /api/bounces and wipes with subscriber", async () => {
  const f = await txFixture({ webhooks: {} });
  cleanups.push(() => f.close());

  const subId = await f.subscriber("mailgun-history@example.com", "History Person");
  const sub = (await f.json(`/api/subscribers/${subId}`)).body.data;

  // Insert a historic bounce with source = 'mailgun'
  f.db.run(
    `INSERT INTO bounces (subscriber_id, type, source, meta, created_at)
     VALUES (?, 'hard', 'mailgun', '{"code":550,"reason":"bounce"}', ?)`,
    [subId, f.clock.now().toISOString()],
  );

  // Shows in GET /api/bounces
  const listRes = await f.json("/api/bounces?source=mailgun");
  expect(listRes.status).toBe(200);
  const bounces = listRes.body.data.results as Array<{ id: number; source: string }>;
  expect(bounces.some((b) => b.source === "mailgun")).toBe(true);

  // Also export the subscriber who owns the source='mailgun' bounce row
  expect((await f.json("/api/settings/privacy.allow_export", "PUT", true)).status).toBe(200);
  const exportRes = await f.request(`/subscription/export/${sub.uuid}`, {
    method: "POST",
  });
  expect(exportRes.status).toBe(200);
  await f.drain();
  const [message] = f.mailTo(sub.email);
  expect(message).toBeDefined();
  const attachment = /filename="?data\.json"?[\s\S]*?\r?\n\r?\n([\s\S]*?)\r?\n--/.exec(
    message!.data,
  );
  expect(attachment).not.toBeNull();
  const report = JSON.parse(Buffer.from(attachment![1]!, "base64").toString("utf8"));
  expect(report.bounces.length).toBe(1);
  expect(report.bounces[0].source).toBe("mailgun");
  expect(report.bounces[0].type).toBe("hard");
  expect(report.bounces[0].meta).toEqual({ code: 550, reason: "bounce" });

  // Public wipe clears the bounce row with the subscriber
  const wipeRes = await f.request(`/subscription/wipe/${sub.uuid}`, {
    method: "POST",
  });
  expect(wipeRes.status).toBe(200);

  const remaining = f.db
    .query("SELECT count(*) as count FROM bounces WHERE subscriber_id = ?")
    .get(subId) as { count: bigint };
  expect(Number(remaining.count)).toBe(0);
});

test("5. Admin settings page Bounces tab shows only SES (no Mailgun, no inert providers, no mailbox editor)", async () => {
  const i18n = createTranslation();
  const page = await settingsView({
    context: {
      app: { i18n, logger: { error() {} } },
      url: new URL("http://fixture.test/admin/settings"),
      request: new Request("http://fixture.test/admin/settings"),
      params: {},
      peerAddress: "127.0.0.1",
    } as any,
    identity: { id: 1, username: "admin", type: "human" } as any,
    site: {
      siteName: "Test Site",
      faviconUrl: "",
      rootUrl: "http://fixture.test",
      lang: "en",
      cacheSlowQueries: false,
      disableTracking: false,
      individualTracking: false,
      fromEmails: [],
      messengers: [],
      publicSubscription: false,
      trustedUrls: [],
      captcha: { provider: "", key: "" },
      customCss: "",
      customJs: "",
    },
    can: () => true,
    listScope: () => ({ all: true, ids: [] }),
  });

  const html = render(page.body);

  // Shows SES
  expect(html).toContain("bounce.ses_topic_arns");

  // Does NOT contain Mailgun or inert provider setting names
  expect(html).not.toContain("bounce.mailgun");
  expect(html).not.toContain("bounce.sendgrid_enabled");
  expect(html).not.toContain("bounce.sendgrid_key");
  expect(html).not.toContain("bounce.postmark");
  expect(html).not.toContain("bounce.forwardemail");
  expect(html).not.toContain("bounce.lettermint");
  expect(html).not.toContain("bounce.azure");
  expect(html).not.toContain("bounce.mailboxes");
});

test("6. OpenAPI document has no Mailgun path, schema, or settings key", () => {
  const doc = JSON.parse(buildDocument());

  expect(doc.paths["/webhooks/bounce/mailgun"]).toBeUndefined();
  expect(doc.components.schemas.MailgunWebhook).toBeUndefined();
  expect(doc.components.schemas.Settings.properties["bounce.mailgun"]).toBeUndefined();
});
